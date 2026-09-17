import { Tile, buildWall, rollDice2, nextForDora } from './mahjong/tiles';
import { WordDef, canWin, findAllDecompositions, findCallCandidates, CallCandidate, canDeclareRiichiHand } from './mahjong/words';
import { computeScore } from './mahjong/score';

export interface RoomRules {
  playerCount: 1 | 2 | 3 | 4;
  length: 'ichikyoku' | 'tonpuu' | 'hanchan' | 'honchan'; // 一局・東風・半荘・本荘
  tileCountPerKind: number; // 2〜8
  timer: '5+20' | '5+300' | 'unlimited';
}

interface Meld { word: string; tiles: Tile[]; from: number; }

interface Player {
  seat: number;
  userId: string;
  username: string;
  hand: Tile[];
  discards: Tile[];
  melds: Meld[];
  riichi: boolean;
  ippatsuActive: boolean;
  score: number;
  ready: boolean;
  connected: boolean;
  isDev?: boolean; // 開発者モードで自動的に埋められた席かどうか
}

type Phase = 'waiting' | 'dealing' | 'playing' | 'finished';

interface PendingRon {
  kind: 'ron';
  discarderSeat: number;
  tile: Tile;
  eligibleSeats: number[];
  decided: Set<number>;
  ronSeats: number[];
}
interface PendingCall {
  kind: 'call';
  discarderSeat: number;
  tile: Tile;
  candidatesBySeat: Record<number, CallCandidate[]>;
  decided: Set<number>;
  chosen: { seat: number; candidate: CallCandidate } | null;
}
type Pending = PendingRon | PendingCall | null;

const DEFAULT_RULES: RoomRules = {
  playerCount: 4,
  length: 'tonpuu',
  tileCountPerKind: 4,
  timer: '5+20',
};

export class GameRoom {
  state: DurableObjectState;
  env: any;
  sockets: Map<number, WebSocket> = new Map(); // seat -> ws
  spectatorSockets: Set<WebSocket> = new Set();

  roomNumber = '';
  hostUserId = '';
  rules: RoomRules = DEFAULT_RULES;
  phase: Phase = 'waiting';
  players: Player[] = [];
  round = 1; // 東1局=1, 東2局=2 ...
  honba = 0;
  dealerSeat = 0;
  wall: Tile[] = [];
  deadWall: Tile[] = [];
  doraIndicators: string[] = [];
  uraDoraIndicators: string[] = [];

  // 開発者モード用：対局開始時の山の並びと、そこから何枚消費したか
  wallSequence: Tile[] = [];
  wallDrawIndex = 0;

  // カン管理
  kanCount = 0;
  kanSeats: Set<number> = new Set();

  currentTurnSeat = 0;
  turnDrawnTile: Tile | null = null;
  pending: Pending = null;
  wordDict: WordDef[] = [];
  initialized = false;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    await this.ensureLoaded();

    if (url.pathname.endsWith('/status')) {
      return Response.json({ exists: this.initialized, phase: this.phase, playerCount: this.players.length, rules: this.rules });
    }
    if (url.pathname.endsWith('/init')) {
      const body = await request.json() as { roomNumber: string; hostUserId: string; rules: RoomRules };
      if (this.initialized) return Response.json({ ok: false, error: 'already exists' }, { status: 409 });
      this.roomNumber = body.roomNumber;
      this.hostUserId = body.hostUserId;
      this.rules = { ...DEFAULT_RULES, ...body.rules };
      this.initialized = true;
      await this.persist();
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith('/ws')) {
      const userId = url.searchParams.get('userId') || '';
      const username = url.searchParams.get('username') || 'ゲスト';
      if (!this.initialized) return new Response('room not found', { status: 404 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      server.accept();
      this.handleSocket(server, userId, username);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('not found', { status: 404 });
  }

  async ensureLoaded() {
    if (this.initialized) return;
    const saved = await this.state.storage.get<any>('room');
    if (saved) {
      Object.assign(this, saved);
      this.initialized = true;
    }
    const dict = await this.loadDict();
    this.wordDict = dict;
  }

  async loadDict(): Promise<WordDef[]> {
    try {
      // 現在のD1スキーマを確認する。
      // 古いDBでは `note`、新しいDBでは `tag` の可能性がある。
      const columns = await this.env.DB
        .prepare('PRAGMA table_info(words)')
        .all();

      const columnNames = new Set(
        (columns.results || []).map((row: any) => String(row.name))
      );

      let tagColumn = 'NULL';

      if (columnNames.has('tag')) {
        tagColumn = 'tag';
      } else if (columnNames.has('note')) {
        tagColumn = 'note';
      }

      const res = await this.env.DB
        .prepare(
          `SELECT word, han, ${tagColumn} AS tag FROM words`
        )
        .all();

      return (res.results || []).map((row: any) => ({
        word: String(row.word),
        han: row.han === 'y' ? 'y' : Number(row.han),
        tag: typeof row.tag === 'string'
          ? row.tag.split(/\s+/).filter(Boolean)
          : [],
      }));
    } catch (e) {
      console.error('辞書読み込み失敗:', e);
      return [];
    }
  }

  async persist() {
    // WebSocket等は保存不可のため、必要最低限の状態のみ保存する
    const snapshot = {
      roomNumber: this.roomNumber,
      hostUserId: this.hostUserId,
      rules: this.rules,
      phase: this.phase,
      round: this.round,
      honba: this.honba,
      dealerSeat: this.dealerSeat,
      players: this.players.map((p) => ({ ...p })),
    };
    await this.state.storage.put('room', snapshot);
  }

  // ホスト席かどうかの判定。開発者モードで自動生成された席は `元のuserId#席番号` という
  // userIdになっているため、前方一致でも判定する。
  isHostSeat(seat: number): boolean {
    const u = this.players[seat]?.userId;
    if (!u) return false;
    return u === this.hostUserId || u.startsWith(this.hostUserId + '#');
  }

  handleSocket(ws: WebSocket, userId: string, username: string) {
    const isAdmin = username === 'administrator'; // 開発者モード判定

    // 既存の自分の席(再接続時)。開発者モードで複数席を持っている場合も
    // `userId#席番号` の前方一致で全て拾い直す。
    let mySeats: number[] = this.players
      .map((_, idx) => idx)
      .filter((idx) => {
        const u = this.players[idx].userId;
        return u === userId || u.startsWith(userId + '#');
      });

    if (mySeats.length === 0 && this.phase === 'waiting') {
      if (isAdmin) {
        // 開発者モード: 人数が足りていない残り全ての席を自分として埋める
        while (this.players.length < this.rules.playerCount) {
          const seat = this.players.length;
          this.players.push({
            seat, userId: `${userId}#${seat}`, username: `${username}(${seat + 1}P)`,
            hand: [], discards: [], melds: [],
            riichi: false, ippatsuActive: false, score: 25000, ready: false, connected: true,
            isDev: true,
          });
          mySeats.push(seat);
        }
      } else if (this.players.length < this.rules.playerCount) {
        const seat = this.players.length;
        this.players.push({
          seat, userId, username, hand: [], discards: [], melds: [],
          riichi: false, ippatsuActive: false, score: 25000, ready: false, connected: true,
        });
        mySeats.push(seat);
      }
    }

    if (mySeats.length === 0) {
      this.spectatorSockets.add(ws);
    } else {
      for (const seat of mySeats) {
        this.players[seat].connected = true;
        this.sockets.set(seat, ws);
      }
    }

    ws.addEventListener('message', (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data as string);
        // 開発者モード: 自分が持つ全ての席を一括で準備OKにする
        if (msg.type === 'devReadyAll' && mySeats.length > 1) {
          for (const s of mySeats) this.players[s].ready = true;
          this.broadcastState();
          this.maybeStart();
          return;
        }
        // 複数席を持つ接続(開発者モード)は、メッセージに含まれる`seat`でどの席として
        // 行動するかを指定する。指定が無い/自分の席でない場合は先頭の席を使う。
        const actingSeat = (typeof msg.seat === 'number' && mySeats.includes(msg.seat)) ? msg.seat : mySeats[0];
        this.onMessage(actingSeat, msg);
      } catch (e) {
        // ignore malformed
      }
    });
    ws.addEventListener('close', () => {
      if (mySeats.length > 0) {
        for (const s of mySeats) {
          this.players[s].connected = false;
          this.sockets.delete(s);
        }
      } else {
        this.spectatorSockets.delete(ws);
      }
      this.broadcastState();
    });

    this.broadcastState();
  }

  send(seat: number, payload: any) {
    const ws = this.sockets.get(seat);
    if (ws) ws.send(JSON.stringify(payload));
  }
  broadcastRaw(payload: any) {
    const json = JSON.stringify(payload);
    const uniqueSockets = new Set(this.sockets.values());
    for (const ws of uniqueSockets) ws.send(json);
    for (const ws of this.spectatorSockets) ws.send(json);
  }

  publicPlayerView(p: Player) {
    return {
      seat: p.seat, userId: p.userId, username: p.username,
      handCount: p.hand.length, discards: p.discards.map((t) => t.kind),
      melds: p.melds.map((m) => ({ word: m.word, tiles: m.tiles.map((t) => t.kind) })),
      riichi: p.riichi, score: p.score, ready: p.ready, connected: p.connected,
    };
  }

  // リーチ宣言が可能かどうか(門前・未リーチ・持ち点1000以上・残り牌4枚以上・
  // かつ実際にどれか1枚切ればテンパイになる)を判定する。
  computeCanRiichi(seat: number): boolean {
    const p = this.players[seat];
    if (!p) return false;
    if (p.riichi) return false;
    if (p.melds.length > 0) return false;
    if (p.score < 1000) return false;
    if (this.wall.length < 4) return false;
    const hand14 = p.hand.map((t) => t.kind);
    if (hand14.length !== 14) return false;
    return canDeclareRiichiHand(hand14, this.wordDict);
  }

  broadcastState() {
    const base = {
      type: 'state',
      roomNumber: this.roomNumber,
      hostUserId: this.hostUserId,
      rules: this.rules,
      phase: this.phase,
      round: this.round,
      honba: this.honba,
      dealerSeat: this.dealerSeat,
      currentTurnSeat: this.currentTurnSeat,
      doraIndicators: this.doraIndicators,
      wallRemaining: this.wall.length,
      players: this.players.map((p) => this.publicPlayerView(p)),
    };

    // 同じWebSocket接続が複数の席を持つ場合(開発者モード)があるため、
    // 接続(ws)単位でグループ化してから、1接続につき1通のstateを送る。
    const wsToSeats = new Map<WebSocket, number[]>();
    for (const [seat, ws] of this.sockets.entries()) {
      if (!wsToSeats.has(ws)) wsToSeats.set(ws, []);
      wsToSeats.get(ws)!.push(seat);
    }

    for (const [ws, seats] of wsToSeats.entries()) {
      const isDev = seats.length > 1 || seats.some((s) => this.players[s]?.isDev);
      // 開発者モードでは、対局中は「今まさに手番が回ってきている席」の視点に自動で切り替える
      const viewSeat = (isDev && this.phase === 'playing' && seats.includes(this.currentTurnSeat))
        ? this.currentTurnSeat
        : seats[0];
      const me = this.players[viewSeat];
      const isMyTurnNow = this.phase === 'playing' && this.currentTurnSeat === viewSeat;
      ws.send(JSON.stringify({
        ...base,
        yourSeat: viewSeat,
        devMode: isDev,
        devSeats: isDev ? seats : undefined,
        // 開発者モード用ゴッドビュー: 全員の手牌を見えるようにする
        devAllHands: isDev ? this.players.map((p) => ({ seat: p.seat, hand: p.hand.map((t) => t.kind).sort() })) : undefined,
        // 開発者モードのみ、山の全体像を送る。
        // history = 既に消費された牌
        // future  = これからツモる牌
        devWall: isDev
          ? {
              history: this.wallSequence
                .slice(0, this.wallDrawIndex)
                .map((t) => t.kind),
              future: this.wallSequence
                .slice(this.wallDrawIndex)
                .map((t) => t.kind),
              drawIndex: this.wallDrawIndex,
              total: this.wallSequence.length,
            }
          : undefined,

        yourHand: me
          ? me.hand
              .map((t) => ({ id: t.id, kind: t.kind }))
              .sort((a, b) => a.kind.localeCompare(b.kind))
          : [],

        yourDrawnTile:
          this.currentTurnSeat === viewSeat && this.turnDrawnTile
            ? {
                id: this.turnDrawnTile.id,
                kind: this.turnDrawnTile.kind,
              }
            : null,
        // 実際にテンパイになる場合のみtrue(サーバー側で判定した正式な値)
        canRiichi: isMyTurnNow ? this.computeCanRiichi(viewSeat) : false,
        canTsumo:
          isMyTurnNow &&
          this.handCharsForWinCheck(me).length === 14 &&
          canWin(
            this.handCharsForWinCheck(me),
            this.wordDict
          ),
      }));
    }
    for (const ws of this.spectatorSockets) {
      ws.send(JSON.stringify({ ...base, yourSeat: -1, yourHand: [], yourDrawnTile: null }));
    }
  }

  onMessage(seat: number, msg: any) {
    switch (msg.type) {
      case 'setRules':
        if (this.isHostSeat(seat) && this.phase === 'waiting') {
          this.rules = { ...this.rules, ...msg.rules };
          this.broadcastState();
        }
        break;
      case 'ready':
        if (this.players[seat]) {
          this.players[seat].ready = !!msg.ready;
          this.broadcastState();
          this.maybeStart();
        }
        break;
      case 'discard':
        this.handleDiscard(seat, msg.tileId, !!msg.riichi);
        break;
      case 'callDecision':
        this.handleCallDecision(seat, msg.accept, msg.word);
        break;
      case 'ronDecision':
        this.handleRonDecision(seat, !!msg.accept);
        break;
      case 'tsumoWin':
        this.handleTsumoWin(seat);
        break;
      default:
        break;
    }
  }

  maybeStart() {
    if (this.phase !== 'waiting') return;
    if (this.players.length !== this.rules.playerCount) return;
    if (!this.players.every((p) => p.ready)) return;
    this.startHand(true);
  }

  // ---------------- 対局進行 ----------------

  startHand(isFirstOfMatch: boolean) {
    this.phase = 'dealing';
    if (isFirstOfMatch) {
      // サイコロ2つを裏で2回振って親決め
      const r1 = rollDice2();
      const r2 = rollDice2();
      this.dealerSeat = (r1 + r2) % this.rules.playerCount;
    }

    const n = this.rules.playerCount;
    this.wall = buildWall(this.rules.tileCountPerKind);

    // 王牌14枚
    this.deadWall = this.wall.splice(this.wall.length - 14, 14);

    // 王牌を除いた実際の山の並びを記録
    // 以後ここから何枚消費されたかを wallDrawIndex で管理する。
    this.wallSequence = [...this.wall];
    this.wallDrawIndex = 0;

    this.kanCount = 0;
    this.kanSeats = new Set();

    for (const p of this.players) {
      p.hand = []; p.discards = []; p.melds = []; p.riichi = false; p.ippatsuActive = false;
    }

    // 4牌ずつ3回
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < n; i++) {
        const seat = (this.dealerSeat + i) % n;
        const draw = this.wall.splice(0, 4);
        this.wallDrawIndex += draw.length;
        this.players[seat].hand.push(...draw);
      }
    }
    // 親はチョンチョン(2枚)
    const dealerDraw = this.wall.splice(0, 2);
    this.wallDrawIndex += dealerDraw.length;
    this.players[this.dealerSeat].hand.push(...dealerDraw);
    // 残りは1枚ずつ
    for (let i = 1; i < n; i++) {
      const seat = (this.dealerSeat + i) % n;
      const draw = this.wall.splice(0, 1);
      this.wallDrawIndex += draw.length;
      this.players[seat].hand.push(...draw);
    }

    // 最初のドラ表示牌
    // deadWall[4] = 表ドラ
    // deadWall[5] = 裏ドラ
    this.doraIndicators = [this.deadWall[4].kind];
    this.uraDoraIndicators = [this.deadWall[5].kind];

    this.phase = 'playing';
    this.currentTurnSeat = this.dealerSeat;
    this.turnDrawnTile = null; // 親は既に14枚持っているので追加ツモ不要
    this.broadcastState();
    this.checkOwnTsumoPossible(this.dealerSeat);
  }

  currentDora(): string[] {
    return this.doraIndicators.map(nextForDora);
  }

  countDora(hand: Tile[], melds: Meld[]): number {
    const dora = new Set(this.currentDora());
    let c = 0;
    for (const t of hand) if (dora.has(t.kind)) c++;
    for (const m of melds) for (const t of m.tiles) if (dora.has(t.kind)) c++;
    return c;
  }

  checkOwnTsumoPossible(seat: number) {
    const p = this.players[seat];
    const allChars = [...p.hand.map((t) => t.kind), ...p.melds.flatMap((m) => m.tiles.map((t) => t.kind))];
    if (allChars.length === 14 && canWin(this.handCharsForWinCheck(p), this.wordDict)) {
      this.send(seat, { type: 'canTsumo', possible: true, seat });
    }
  }

  // 鳴きで晒した分も含めて14文字になるようにする
  handCharsForWinCheck(p: Player): string[] {
    const concealed = p.hand.map((t) => t.kind);
    const melded = p.melds.flatMap((m) => m.word.split(''));
    return [...concealed, ...melded];
  }

  handleDiscard(seat: number, tileId: string, riichiDeclare: boolean) {
    if (this.phase !== 'playing' || this.currentTurnSeat !== seat) return;
    const p = this.players[seat];
    // クライアントはkindのみ送ってくる簡易実装のため、id一致→kind一致の順でフォールバックする
    let idx = p.hand.findIndex((t) => t.id === tileId);
    if (idx === -1) idx = p.hand.findIndex((t) => t.kind === tileId);
    if (idx === -1) return;
    if (riichiDeclare) p.riichi = true;
    const [tile] = p.hand.splice(idx, 1);
    p.discards.push(tile);
    this.turnDrawnTile = null;

    // 他家の一発チャンスを消す（自分以外のリーチの一発は他家の鳴き/自分の打牌で消える等の細則は簡略化）
    for (const pl of this.players) if (pl.seat !== seat) pl.ippatsuActive = false;

    this.broadcastState();
    this.offerRon(seat, tile);
  }

  offerRon(discarderSeat: number, tile: Tile) {
    const n = this.rules.playerCount;
    const eligible: number[] = [];
    for (let i = 1; i < n; i++) {
      const seat = (discarderSeat + i) % n;
      const p = this.players[seat];
      const chars = [...this.handCharsForWinCheck(p), tile.kind];
      if (canWin(chars, this.wordDict)) eligible.push(seat);
    }
    if (eligible.length === 0) {
      this.offerCalls(discarderSeat, tile);
      return;
    }
    this.pending = { kind: 'ron', discarderSeat, tile, eligibleSeats: eligible, decided: new Set(), ronSeats: [] };
    for (const seat of eligible) this.send(seat, { type: 'ronPrompt', tile: tile.kind, seat });
  }

  handleRonDecision(seat: number, accept: boolean) {
    if (!this.pending || this.pending.kind !== 'ron') return;
    if (!this.pending.eligibleSeats.includes(seat) || this.pending.decided.has(seat)) return;
    this.pending.decided.add(seat);
    if (accept) this.pending.ronSeats.push(seat);
    if (this.pending.decided.size === this.pending.eligibleSeats.length) {
      this.resolveRonPhase();
    }
  }

  resolveRonPhase() {
    const pend = this.pending as PendingRon;
    this.pending = null;
    if (pend.ronSeats.length > 0) {
      this.finishHandByRon(pend.discarderSeat, pend.tile, pend.ronSeats);
    } else {
      this.offerCalls(pend.discarderSeat, pend.tile);
    }
  }

  offerCalls(discarderSeat: number, tile: Tile) {
    const n = this.rules.playerCount;
    const candidatesBySeat: Record<number, CallCandidate[]> = {};
    for (let i = 1; i < n; i++) {
      const seat = (discarderSeat + i) % n;
      const p = this.players[seat];
      const cands = findCallCandidates(p.hand.map((t) => t.kind), tile.kind, this.wordDict);
      if (cands.length > 0) candidatesBySeat[seat] = cands;
    }
    const seats = Object.keys(candidatesBySeat).map(Number);
    if (seats.length === 0) {
      this.advanceTurnAfterDiscard(discarderSeat);
      return;
    }
    this.pending = { kind: 'call', discarderSeat, tile, candidatesBySeat, decided: new Set(), chosen: null };
    for (const seat of seats) this.send(seat, { type: 'callPrompt', tile: tile.kind, candidates: candidatesBySeat[seat], seat });
  }

  // 優先順位: 下家 > 対面 > 上家 (捨てた人から見て)
  callPriorityOrder(discarderSeat: number): number[] {
    const n = this.rules.playerCount;
    const order: number[] = [];
    for (let i = 1; i < n; i++) order.push((discarderSeat + i) % n);
    return order; // (discarderSeat+1)=下家 が先頭になるようすでに順序通り
  }

  handleCallDecision(seat: number, accept: boolean, word?: string) {
    if (!this.pending || this.pending.kind !== 'call') return;
    const pend = this.pending;
    if (!(seat in pend.candidatesBySeat) || pend.decided.has(seat)) return;
    pend.decided.add(seat);
    if (accept && word) {
      const cand = pend.candidatesBySeat[seat].find((c) => c.word === word);
      if (cand && !pend.chosen) {
        pend.chosen = { seat, candidate: cand };
      }
    }
    const allSeats = Object.keys(pend.candidatesBySeat).map(Number);
    if (pend.decided.size === allSeats.length) {
      this.resolveCallPhase();
    }
  }

  resolveCallPhase() {
    const pend = this.pending as PendingCall;
    this.pending = null;
    if (!pend.chosen) {
      this.advanceTurnAfterDiscard(pend.discarderSeat);
      return;
    }
    // 優先順位判定: 複数人が鳴き宣言していた場合、下家>対面>上家の順で最優先の人を採用
    const priority = this.callPriorityOrder(pend.discarderSeat);
    let winnerSeat = pend.chosen.seat;
    let winnerCand = pend.chosen.candidate;
    for (const s of priority) {
      // すでにchosenが優先順位内で最初に accept した人とは限らないため、
      // 全acceptした人の中から優先順位最上位を選び直す
    }
    // pend.chosen は最初に accept が来た人を暫定採用しているため、
    // 全員の決定が出揃った時点で優先順位に沿って選び直す。
    // (簡易実装: decided集合の中でacceptしたseat一覧を再構成)
    // ここでは chosen をそのまま採用(下家側から先に送信される運用を想定)。

    const discarder = this.players[pend.discarderSeat];
    const caller = this.players[winnerSeat];

    // 鳴いた牌を捨て牌から除去
    const tileIdx = discarder.discards.findIndex(
      (t) => t.id === pend.tile.id
    );
    if (tileIdx !== -1) {
      discarder.discards.splice(tileIdx, 1);
    }

    // 手牌から使用分を取り除く
    const used: Tile[] = [];
    const remaining = [...caller.hand];

    for (const ch of winnerCand.usedFromHand) {
      const idx = remaining.findIndex((t) => t.kind === ch);
      if (idx !== -1) {
        used.push(remaining[idx]);
        remaining.splice(idx, 1);
      }
    }

    caller.hand = remaining;

    const meldTiles = [pend.tile, ...used];

    caller.melds.push({
      word: winnerCand.word,
      tiles: meldTiles,
      from: pend.discarderSeat,
    });

    // 鳴きが入ったので一発は消える
    for (const pl of this.players) {
      pl.ippatsuActive = false;
    }

    // --------------------------------------------------
    // 5文字以上の単語で完成した鳴きは内部的に「カン」として扱う
    // --------------------------------------------------
    const isKan = winnerCand.word.length >= 5;

    if (isKan) {
      this.kanCount += 1;
      this.kanSeats.add(winnerSeat);

      // 複数人による計4回目のカン → 四槓散了
      // 同一人物だけで4回なら四槓子を目指せるので続行。
      if (this.kanCount >= 4 && this.kanSeats.size >= 2) {
        this.currentTurnSeat = winnerSeat;
        this.turnDrawnTile = null;
        this.broadcastState();
        this.exhaustiveDraw('four-kan');
        return;
      }

      // カン成立時に新しいドラ表示牌をめくる。
      // 1回目: deadWall[4]
      // 2回目: deadWall[6]
      // 3回目: deadWall[8]
      // 4回目: deadWall[10]
      // したがって裏ドラ側は [5,7,9,11,13]
      const doraIndex = 4 + (this.kanCount - 1) * 2;
      const uraIndex = doraIndex + 1;

      if (
        doraIndex >= this.deadWall.length ||
        uraIndex >= this.deadWall.length
      ) {
        this.currentTurnSeat = winnerSeat;
        this.turnDrawnTile = null;
        this.broadcastState();
        this.exhaustiveDraw('dead-wall-error');
        return;
      }

      this.doraIndicators.push(this.deadWall[doraIndex].kind);
      this.uraDoraIndicators.push(this.deadWall[uraIndex].kind);

      // 嶺上牌からツモる
      // deadWall[0], [1], [2], [3] の4枚を順番に使う
      const rinshanIndex = this.kanCount - 1;
      const drawn = this.deadWall[rinshanIndex];

      if (!drawn) {
        this.currentTurnSeat = winnerSeat;
        this.turnDrawnTile = null;
        this.broadcastState();
        this.exhaustiveDraw('rinshan-empty');
        return;
      }

      caller.hand.push(drawn);

      this.currentTurnSeat = winnerSeat;
      this.turnDrawnTile = drawn;

      this.broadcastState();
      this.checkOwnTsumoPossible(winnerSeat);

      // カンした人は嶺上牌をツモった状態で打牌待ち
      return;
    }

    // --------------------------------------------------
    // 通常の鳴き
    // --------------------------------------------------
    this.currentTurnSeat = winnerSeat;
    this.turnDrawnTile = null;

    this.broadcastState();
    this.checkOwnTsumoPossible(winnerSeat);

    // 通常の鳴きはツモらず、そのまま打牌
  }

  advanceTurnAfterDiscard(discarderSeat: number) {
    const n = this.rules.playerCount;
    // 四家立直チェック(全員リーチしたら流局)
    if (this.players.every((p) => p.riichi)) {
      this.exhaustiveDraw('four-riichi');
      return;
    }
    if (this.wall.length === 0) {
      this.exhaustiveDraw('wall-empty');
      return;
    }
    const nextSeat = (discarderSeat + 1) % n;
    this.currentTurnSeat = nextSeat;
    const drawn = this.wall.shift()!;
    this.wallDrawIndex += 1;
    this.players[nextSeat].hand.push(drawn);
    this.turnDrawnTile = drawn;
    this.broadcastState();
    this.checkOwnTsumoPossible(nextSeat);
  }

  handleTsumoWin(seat: number) {
    if (this.phase !== 'playing' || this.currentTurnSeat !== seat) return;
    const p = this.players[seat];
    const chars = this.handCharsForWinCheck(p);
    const decomps = findAllDecompositions(chars, this.wordDict, 50);
    if (decomps.length === 0) return; // 不正な和了宣言
    this.finishHandByTsumo(seat, decomps);
  }

  bestDecomposition(chars: string[], doraCount: number, riichi: boolean, ippatsu: boolean, isDealer: boolean, winType: 'ron' | 'tsumo') {
    const decomps = findAllDecompositions(chars, this.wordDict, 200);
    let best = null as any;
    for (const d of decomps) {
      const s = computeScore({
        words: d.words, dict: this.wordDict, doraIndicators: this.doraIndicators,
        handWithDoraCount: doraCount, riichi, ippatsu, isDealer, winType,
      });
      if (!best || s.payments.total > best.score.payments.total) best = { decomp: d, score: s };
    }
    return best;
  }

  finishHandByTsumo(seat: number, decomps: any[]) {
    const p = this.players[seat];
    const chars = this.handCharsForWinCheck(p);
    const doraCount = this.countDora(p.hand, p.melds);
    const isDealer = seat === this.dealerSeat;
    const best = this.bestDecomposition(chars, doraCount, p.riichi, p.ippatsuActive, isDealer, 'tsumo');
    if (!best) return;
    const { score } = best;

    if (isDealer) {
      for (const pl of this.players) if (pl.seat !== seat) pl.score -= score.payments.fromNonDealer!;
      p.score += score.payments.total;
    } else {
      for (const pl of this.players) {
        if (pl.seat === seat) continue;
        if (pl.seat === this.dealerSeat) pl.score -= score.payments.fromDealer!;
        else pl.score -= score.payments.fromNonDealer!;
      }
      p.score += score.payments.total;
    }

    this.broadcastRaw({ type: 'result', kind: 'tsumo', winner: seat, decomp: best.decomp, score, uraDora: p.riichi ? this.uraDoraIndicators.map(nextForDora) : [] });
    this.endHandAndAdvance(isDealer);
  }

  finishHandByRon(discarderSeat: number, tile: Tile, ronSeats: number[]) {
    // ダブロン・トリロン対応: 全員に対して個別に精算する
    const results: any[] = [];
    let dealerWon = false;
    for (const seat of ronSeats) {
      const p = this.players[seat];
      const chars = [...this.handCharsForWinCheck(p), tile.kind];
      const isDealer = seat === this.dealerSeat;
      const doraCount = this.countDora([...p.hand, tile], p.melds);
      const best = this.bestDecomposition(chars, doraCount, p.riichi, p.ippatsuActive, isDealer, 'ron');
      if (!best) continue;
      if (isDealer) dealerWon = true;
      this.players[discarderSeat].score -= best.score.payments.total;
      p.score += best.score.payments.total;
      results.push({ winner: seat, decomp: best.decomp, score: best.score, uraDora: p.riichi ? this.uraDoraIndicators.map(nextForDora) : [] });
    }
    this.broadcastRaw({ type: 'result', kind: 'ron', discarder: discarderSeat, results });
    this.endHandAndAdvance(dealerWon);
  }

  exhaustiveDraw(reason: string) {
    // 簡易実装: テンパイ/ノーテン判定は省略し、親のみ連荘扱いとする拡張余地あり
    this.broadcastRaw({ type: 'result', kind: 'draw', reason });
    this.endHandAndAdvance(true);
  }

  endHandAndAdvance(dealerContinues: boolean) {
    this.honba = dealerContinues ? this.honba + 1 : 0;
    if (!dealerContinues) {
      this.round += 1;
      this.dealerSeat = (this.dealerSeat + 1) % this.rules.playerCount;
    }
    if (this.isMatchOver()) {
      this.phase = 'finished';
      this.broadcastRaw({ type: 'matchEnd', finalScores: this.players.map((p) => ({ seat: p.seat, username: p.username, score: p.score })) });
      this.persist();
      return;
    }
    for (const p of this.players) p.ready = false;
    this.phase = 'waiting';
    this.broadcastState();
    // 実運用では次局開始も全員準備OKで開始する想定。ここでは自動継続する。
    this.startHand(false);
  }

  isMatchOver(): boolean {
    const roundsPerWind = 1; // 東/南 それぞれ何局か(1局固定の簡易実装。必要に応じ拡張)
    switch (this.rules.length) {
      case 'ichikyoku': return this.round > 1;
      case 'tonpuu': return this.round > 4;   // 東1〜東4
      case 'hanchan': return this.round > 8;  // 東1〜南4 相当(簡易)
      case 'honchan': return this.round > 16; // 東南西北 相当(簡易)
      default: return this.round > 4;
    }
  }
}