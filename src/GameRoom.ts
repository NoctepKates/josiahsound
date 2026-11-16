import { Tile, buildWall, rollDice2, nextForDora } from './mahjong/tiles';
import { WordDef, canWin, findAllDecompositions, findCallCandidates, CallCandidate, findRiichiDiscards, findWaits } from './mahjong/words';
import { chooseCpuCall, chooseCpuDiscard, cpuStrengthConfig, normalizeCpuStrength } from './mahjong/cpu';
import { computeScore } from './mahjong/score';

export interface RoomRules {
  playerCount: 1 | 2 | 3 | 4;
  length: 'ichikyoku' | 'tonpuu' | 'hanchan' | 'honchan'; // 一局・東風・半荘・本荘
  tileCountPerKind: number; // 2〜8
  timer: '5+20' | '5+300' | 'unlimited';
  tobi: boolean; // 飛びあり(true)/なし(false)。ありの場合、持ち点がマイナスになった時点で対局終了
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
  // フリテン(ロンだけできない。ツモ・鳴きはできる)。
  // furitenTemp: ロンを見逃した直後。自分の次の打牌で解除される。
  // furitenRiichi: リーチ後にロンを見逃した。その局が終わるまで続く。
  furitenTemp?: boolean;
  furitenRiichi?: boolean;
  score: number;
  ready: boolean;
  connected: boolean;
  isDev?: boolean; // 開発者モードで自動的に埋められた席かどうか
  isCpu?: boolean; // CPUの席かどうか(ソケットを持たず、サーバーが打牌・鳴きを決める)
  cpuStrength?: number; // CPUの強さ(1〜5)。未設定の古い席は3として扱う
  avatarV?: number; // プロフィール画像の更新時刻(0/未設定なら画像なし)
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
  // 鳴きを受け入れた全員の宣言。解決時に優先順位(下家>対面>上家)で選び直す。
  accepted: { seat: number; candidate: CallCandidate }[];
}
type Pending = PendingRon | PendingCall | null;

const DEFAULT_RULES: RoomRules = {
  playerCount: 4,
  length: 'tonpuu',
  tileCountPerKind: 4,
  timer: '5+20',
  tobi: true,
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
  riichiSticks = 0; // 供託のリーチ棒(1000点棒)の本数。和了した人が総取りし、流局では持ち越す
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
  dictLoadedAt = 0; // 辞書を最後にD1から読んだ時刻(ms)
  initialized = false;

  // CPUの打牌タイマー。WebSocketが繋がっている間はDOが常駐するため、
  // 短い setTimeout で人間が見える間を置いて打たせる。世代番号で古いタイマーを無効化する。
  cpuTimer: ReturnType<typeof setTimeout> | null = null;
  cpuTimerGeneration = 0;
  // CPUのランダム判定に使う乱数。テストで固定できるようフィールドにしている。
  rng: () => number = Math.random;

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
    if (!this.initialized) {
      const saved = await this.state.storage.get<any>('room');
      if (saved) {
        Object.assign(this, saved);
        this.initialized = true;
      }
    }

    // 辞書は「部屋が最初に読み込まれた時の1回だけ」読むと、
    //  ・最初の読み込みに失敗して空のまま
    //  ・その後D1の単語を追加/変更しても反映されない
    // となり、デバッグ画面(毎回D1を読む)では和了なのに実戦ではツモ/リーチが出ない、
    // という食い違いの原因になる。空なら必ず読み直し、それ以外も一定間隔で更新する。
    await this.refreshDict(this.wordDict.length === 0);
  }

  // 辞書をD1から読み直す。force でなければ10秒以内の再読み込みは省略する。
  // 読み込みに失敗した場合(空配列)は、今ある辞書を捨てずに残す。
  async refreshDict(force = false) {
    if (!force && this.wordDict.length > 0 && Date.now() - this.dictLoadedAt < 10_000) {
      return;
    }
    const dict = await this.loadDict();
    if (dict.length > 0) {
      this.wordDict = dict;
      this.dictLoadedAt = Date.now();
    }
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
      riichiSticks: this.riichiSticks,
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

  // プロフィール画像の更新時刻(users.avatar_updated)をDBから読み、席に記録する。
  // 画像そのものは /api/avatar/<userId>?v=<更新時刻> から配信するので、stateには載せない。
  async loadAvatarFor(userId: string, seats: number[]) {
    try {
      const row = await this.env.DB
        .prepare('SELECT avatar_updated AS v FROM users WHERE user_id = ?')
        .bind(userId)
        .first();

      const v = Number((row as any)?.v) || 0;
      let changed = false;

      for (const seat of seats) {
        const pl = this.players[seat];
        if (pl && (pl.avatarV || 0) !== v) {
          pl.avatarV = v;
          changed = true;
        }
      }

      if (changed) this.broadcastState();
    } catch {
      // 列がまだ無い(一度も画像が設定されていない)場合などは、画像なしのまま進める
    }
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

    if (mySeats.length > 0) {
      // プロフィール画像の有無を調べて、席に記録する(分かり次第、全員にstateを送り直す)
      void this.loadAvatarFor(userId, mySeats);
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
      isCpu: !!p.isCpu,
      cpuStrength: p.isCpu ? (p.cpuStrength ?? 3) : undefined,
      // プロフィール画像(設定していなければ null)。開発者モードの席(`ID#席番号`)も元のユーザーの画像を使う
      avatarUrl: p.avatarV
        ? `/api/avatar/${encodeURIComponent(p.userId.split('#')[0])}?v=${p.avatarV}`
        : null,
    };
  }

  // リーチ宣言の条件(門前・未リーチ・持ち点1000以上・残り牌4枚以上)を満たしたうえで、
  // 「その牌を切るとテンパイになる」打牌の牌種を返す。空ならリーチできない。
  // テンパイの定義はデバッグ画面(/debug/hand)と共通(mahjong/words.ts の findRiichiDiscards)。
  computeRiichiDiscards(seat: number): string[] {
    const p = this.players[seat];
    if (!p) return [];
    if (p.riichi) return [];
    if (p.melds.length > 0) return [];
    if (p.score < 1000) return [];
    if (this.wall.length < 4) return [];
    const hand14 = p.hand.map((t) => t.kind);
    if (hand14.length !== 14) return [];
    return findRiichiDiscards(hand14, this.wordDict).map((d) => d.discard);
  }

  computeCanRiichi(seat: number): boolean {
    return this.computeRiichiDiscards(seat).length > 0;
  }

  // ツモ和了できるか(鳴いて晒した分も含めて14文字が単語だけで分解できるか)
  computeCanTsumo(seat: number): boolean {
    const p = this.players[seat];
    if (!p) return false;
    const chars = this.handCharsForWinCheck(p);
    return chars.length === 14 && canWin(chars, this.wordDict);
  }

  // 捨て牌フリテン: 今の待ち牌のうち1種類でも、自分の捨て牌に含まれている。
  // 待ち牌はデバッグ画面と同じ定義(findWaits)。13枚でない手(打牌前の14枚など)は対象外。
  isDiscardFuriten(seat: number): boolean {
    const p = this.players[seat];
    if (!p) return false;
    const chars = this.handCharsForWinCheck(p);
    if (chars.length !== 13) return false;
    const waits = findWaits(chars, this.wordDict);
    if (waits.length === 0) return false;
    const discarded = new Set(p.discards.map((t) => t.kind));
    return waits.some((w) => discarded.has(w));
  }

  // フリテンかどうか。ロンだけができなくなり、ツモと鳴きはできる。
  isFuriten(seat: number): boolean {
    const p = this.players[seat];
    if (!p) return false;
    return !!(p.furitenTemp || p.furitenRiichi || this.isDiscardFuriten(seat));
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
      riichiSticks: this.riichiSticks,
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
      const riichiDiscards = isMyTurnNow ? this.computeRiichiDiscards(viewSeat) : [];
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
        canRiichi: riichiDiscards.length > 0,
        // リーチ宣言のときに切れる牌種(これ以外を切るとテンパイにならない)
        riichiDiscards,
        canTsumo: isMyTurnNow && this.computeCanTsumo(viewSeat),
        // 自分のフリテン(他人の手牌情報が漏れないよう、自分の席ぶんだけ送る)
        yourFuriten: this.phase === 'playing' ? this.isFuriten(viewSeat) : false,
      }));
    }
    for (const ws of this.spectatorSockets) {
      ws.send(JSON.stringify({ ...base, yourSeat: -1, yourHand: [], yourDrawnTile: null }));
    }
  }

  onMessage(seat: number, msg: any) {
    switch (msg.type) {
      case 'addCpu':
        this.addCpu(seat, msg.strength);
        break;
      case 'removeCpu':
        this.removeCpu(seat, msg.targetSeat);
        break;
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

  // ---------------- CPU ----------------

  // CPUを1席追加する。ホストだけが、待機中に、空きがある場合に呼べる。
  // CPUは最初から準備OKなので、人数が揃い人間が全員準備OKになればすぐ対局が始まる。
  addCpu(requesterSeat: number, strength?: unknown) {
    if (this.phase !== 'waiting') {
      this.send(requesterSeat, { type: 'notice', message: '対局開始後はCPUを追加できません。' });
      return;
    }
    if (!this.isHostSeat(requesterSeat)) {
      this.send(requesterSeat, { type: 'notice', message: 'CPUを追加できるのはホストだけです。' });
      return;
    }
    if (this.players.length >= this.rules.playerCount) {
      this.send(requesterSeat, { type: 'notice', message: '部屋が満員です。' });
      return;
    }
    const seat = this.players.length;
    const usedNames = new Set(this.players.map((p) => p.username));
    let n = 1;
    while (usedNames.has(`CPU ${n}`)) n++;
    this.players.push({
      seat, userId: `cpu:${this.roomNumber}:${seat}`, username: `CPU ${n}`,
      hand: [], discards: [], melds: [],
      riichi: false, ippatsuActive: false, score: 25000, ready: true, connected: true,
      isCpu: true,
      cpuStrength: normalizeCpuStrength(strength),
    });
    this.broadcastState();
    this.maybeStart();
  }

  // CPUを1席削除する。席番号の詰め直しで人間の接続情報がずれないよう、
  // 一番最後の席がCPUの場合だけ削除できる。
  removeCpu(requesterSeat: number, targetSeat: number) {
    if (this.phase !== 'waiting') {
      this.send(requesterSeat, { type: 'notice', message: '対局開始後はCPUを削除できません。' });
      return;
    }
    if (!this.isHostSeat(requesterSeat)) {
      this.send(requesterSeat, { type: 'notice', message: 'CPUを削除できるのはホストだけです。' });
      return;
    }
    if (targetSeat !== this.players.length - 1 || !this.players[targetSeat]?.isCpu) {
      this.send(requesterSeat, { type: 'notice', message: '一番最後の席のCPUだけ削除できます。' });
      return;
    }
    this.players.pop();
    this.broadcastState();
  }

  // 手番がCPUなら、少し間を置いて打たせるタイマーを仕掛ける。
  maybeScheduleCpuTurn() {
    if (this.phase !== 'playing' || this.pending) return;
    if (!this.players[this.currentTurnSeat]?.isCpu) return;
    if (this.cpuTimer) clearTimeout(this.cpuTimer);
    this.cpuTimer = null;
    const generation = ++this.cpuTimerGeneration;
    this.cpuTimer = setTimeout(() => {
      this.cpuTimer = null;
      if (generation !== this.cpuTimerGeneration) return;
      try {
        this.runCpuTurn();
      } catch (e) {
        console.error('CPUターン失敗:', e);
      }
    }, 700);
  }

  // CPUの手番を1回進める。ツモ和了できるなら宣言し、そうでなければ
  // 手牌分析に基づいて1枚切る(リーチできる場合は宣言する)。
  runCpuTurn() {
    if (this.phase !== 'playing' || this.pending) return;
    const seat = this.currentTurnSeat;
    const p = this.players[seat];
    if (!p?.isCpu) return;
    const strength = p.cpuStrength ?? 3;
    const cfg = cpuStrengthConfig(strength);
    // 弱いCPUはツモを見逃すことがある。見逃した場合は普通に打牌する。
    if (this.computeCanTsumo(seat) && this.rng() >= cfg.winMissChance) {
      this.handleTsumoWin(seat);
      return;
    }
    const decision = chooseCpuDiscard({
      handKinds: p.hand.map((t) => t.kind),
      meldWordChars: p.melds.flatMap((m) => m.word.split('')),
      dict: this.wordDict,
      doraKinds: [
        ...this.currentDora(),
        ...(p.riichi ? this.uraDoraIndicators.map(nextForDora) : []),
      ],
      drawnKind: this.turnDrawnTile?.kind ?? null,
      riichiDiscards: this.computeRiichiDiscards(seat),
      isRiichi: p.riichi,
      strength,
      rng: this.rng,
    });
    if (!decision.discardKind) return;
    // ツモ切り(切る牌がツモ牌と同じ牌種)の場合はツモ牌そのものを切る。
    const drawn = this.turnDrawnTile;
    const tile = (drawn && drawn.kind === decision.discardKind && p.hand.some((t) => t.id === drawn.id))
      ? drawn
      : p.hand.find((t) => t.kind === decision.discardKind);
    if (!tile) return;
    this.handleDiscard(seat, tile.id, decision.riichi);
  }

  // ロン・鳴きの判断待ちで、CPUの席のぶんをその場で決める。
  // 人間の判断は待ったままなので、解決は全員の判断が出揃ってから行われる。
  decideCpuPending() {
    if (!this.pending) return;
    if (this.pending.kind === 'ron') {
      for (const seat of [...this.pending.eligibleSeats]) {
        if (!this.pending || this.pending.kind !== 'ron') break;
        const p = this.players[seat];
        if (p?.isCpu) {
          // ロンできる席だけが eligible に入っている。弱いCPUはたまに見逃す。
          // (見逃すとフリテンになるので、handleRonDecision の判定はそのまま使う)
          const cfg = cpuStrengthConfig(p.cpuStrength ?? 3);
          this.handleRonDecision(seat, this.rng() >= cfg.winMissChance);
        }
      }
      return;
    }
    const seats = Object.keys(this.pending.candidatesBySeat).map(Number);
    for (const seat of seats) {
      if (!this.pending || this.pending.kind !== 'call') break;
      const p = this.players[seat];
      if (!p?.isCpu) continue;
      const candidates = this.pending.candidatesBySeat[seat];
      if (!candidates) continue;
      const decision = chooseCpuCall({
        handKinds: p.hand.map((t) => t.kind),
        meldWordChars: p.melds.flatMap((m) => m.word.split('')),
        dict: this.wordDict,
        doraKinds: this.currentDora(),
        candidates,
        isRiichi: p.riichi,
        strength: p.cpuStrength ?? 3,
        rng: this.rng,
      });
      this.handleCallDecision(seat, decision.accept, decision.word);
    }
  }

  // ---------------- 対局進行 ----------------

  startHand(isFirstOfMatch: boolean) {
    this.phase = 'dealing';

    // 局の開始ごとに辞書を読み直す(D1の単語の追加・変更を実戦に反映する)。
    // 配牌をブロックしないよう待たずに実行し、失敗しても今の辞書を使い続ける。
    void this.refreshDict(true).catch(() => {});
    if (isFirstOfMatch) {
      // サイコロ2つを裏で2回振って親決め
      const r1 = rollDice2();
      const r2 = rollDice2();
      this.dealerSeat = (r1 + r2) % this.rules.playerCount;
      this.riichiSticks = 0;
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
      p.furitenTemp = false; p.furitenRiichi = false;
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
    this.maybeScheduleCpuTurn();
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
    if (this.computeCanTsumo(seat)) {
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
    if (riichiDeclare) {
      // リーチ宣言できるのは、切ればテンパイになる牌だけ。
      // (以前は判定せずに宣言できてしまっていた)
      if (!this.computeRiichiDiscards(seat).includes(p.hand[idx].kind)) {
        this.send(seat, {
          type: 'notice',
          message: 'その牌を切ってもテンパイにならないため、リーチできません。',
        });
        return;
      }
      p.riichi = true;

      // リーチ棒(1000点)を供託に出す(持ち点が1000未満の人は computeRiichiDiscards で弾かれる)
      p.score -= 1000;
      this.riichiSticks += 1;
    }
    const [tile] = p.hand.splice(idx, 1);
    p.discards.push(tile);
    this.turnDrawnTile = null;
    // 自分の打牌で、一時的なフリテンは解除される(リーチ後のフリテンは局終了まで残る)。
    p.furitenTemp = false;

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
      // フリテンの席はロンできない(見逃し・リーチ後のフラグが立っている席は和了判定を省く)。
      if (p.furitenTemp || p.furitenRiichi) continue;
      const chars = [...this.handCharsForWinCheck(p), tile.kind];
      if (!canWin(chars, this.wordDict)) continue;
      if (this.isDiscardFuriten(seat)) continue;
      eligible.push(seat);
    }
    if (eligible.length === 0) {
      this.offerCalls(discarderSeat, tile);
      return;
    }
    this.pending = { kind: 'ron', discarderSeat, tile, eligibleSeats: eligible, decided: new Set(), ronSeats: [] };
    for (const seat of eligible) this.send(seat, { type: 'ronPrompt', tile: tile.kind, seat });
    this.decideCpuPending();
  }

  handleRonDecision(seat: number, accept: boolean) {
    if (!this.pending || this.pending.kind !== 'ron') return;
    if (!this.pending.eligibleSeats.includes(seat) || this.pending.decided.has(seat)) return;
    this.pending.decided.add(seat);
    if (accept) this.pending.ronSeats.push(seat);
    if (!accept) {
      // ロンを見逃すとフリテンになる。リーチ後はその局が終わるまで、通常は自分の次の打牌まで。
      const p = this.players[seat];
      if (p) {
        if (p.riichi) p.furitenRiichi = true;
        else p.furitenTemp = true;
      }
      // フリテンになったことを、次に送るstateに反映させる。
      this.broadcastState();
    }
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
    this.pending = { kind: 'call', discarderSeat, tile, candidatesBySeat, decided: new Set(), accepted: [] };
    for (const seat of seats) this.send(seat, { type: 'callPrompt', tile: tile.kind, candidates: candidatesBySeat[seat], seat });
    this.decideCpuPending();
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
      if (cand) {
        pend.accepted.push({ seat, candidate: cand });
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
    // 優先順位: 複数人が鳴き宣言していた場合、下家>対面>上家の順で最優先の人を採用する。
    // (以前は最初に accept が届いた人をそのまま採用していた)
    const priority = this.callPriorityOrder(pend.discarderSeat);
    const winner = priority
      .map((s) => pend.accepted.find((a) => a.seat === s))
      .find((a) => a !== undefined);
    if (!winner) {
      this.advanceTurnAfterDiscard(pend.discarderSeat);
      return;
    }
    const winnerSeat = winner.seat;
    const winnerCand = winner.candidate;

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
      this.maybeScheduleCpuTurn();

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
    this.maybeScheduleCpuTurn();

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
    this.maybeScheduleCpuTurn();
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

    // 供託のリーチ棒は和了した人が総取りする
    const riichiBonus = this.riichiSticks * 1000;
    p.score += riichiBonus;
    this.riichiSticks = 0;

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
    // 供託のリーチ棒は、和了した人(ダブロンなら放銃者に最も近い人=先頭)が総取りする
    if (results.length > 0) {
      const riichiBonus = this.riichiSticks * 1000;
      this.players[results[0].winner].score += riichiBonus;
      this.riichiSticks = 0;
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
    // 飛び: 持ち点がマイナス(0点ちょうどは飛ばない)になった人がいれば、局数に関わらず対局終了。
    // tobi が未設定の古い部屋は、デフォルトの「あり」として扱う。
    if (this.rules.tobi !== false) {
      const tobiSeats = this.players.filter((p) => p.score < 0).map((p) => p.seat);
      if (tobiSeats.length > 0) {
        this.finishMatch('tobi', tobiSeats);
        return;
      }
    }
    this.honba = dealerContinues ? this.honba + 1 : 0;
    if (!dealerContinues) {
      this.round += 1;
      this.dealerSeat = (this.dealerSeat + 1) % this.rules.playerCount;
    }
    if (this.isMatchOver()) {
      this.finishMatch('complete');
      return;
    }
    for (const p of this.players) p.ready = false;
    this.phase = 'waiting';
    this.broadcastState();
    // 実運用では次局開始も全員準備OKで開始する想定。ここでは自動継続する。
    this.startHand(false);
  }

  finishMatch(reason: 'complete' | 'tobi', tobiSeats: number[] = []) {
    this.phase = 'finished';
    this.broadcastRaw({
      type: 'matchEnd',
      reason,
      tobiSeats: reason === 'tobi' ? tobiSeats : [],
      finalScores: this.players.map((p) => ({ seat: p.seat, username: p.username, score: p.score })),
    });
    this.persist();
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