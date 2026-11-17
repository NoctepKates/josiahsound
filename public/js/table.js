const code = new URLSearchParams(location.search).get('code');
let ws = null;
let state = null;
let selectedTileId = null;
let riichiMode = false;
let canTsumoNow = false;
let reconnectAttempts = 0;
let dragFromIdx = null;
let devGodView = true; // 開発者モード: 他プレイヤーの手牌も見えるようにするか
let devWallVisible = false;

// 待ちプレビュー(リーチ時に、選んだ牌を切った場合の待ち)
let previewData = null;
let previewTileId = null;
let lastTurnKey = null;
let autoTsumogiriKey = null; // 自動ツモ切り済みの印(局ID:ツモ牌ID)

// 鳴きパネル・結果画面の状態
let callPanelOpen = false;
let currentCallPrompt = null;
let resultFlowActive = false; // 結果画面を表示中(帯〜詳細〜点数移動の間)
let resultHandId = null;
let currentResultMsg = null;
let pendingMatchEnd = null;
let readySent = false;

let handOrder = [];

const SEAT_DIV_ORDER = ['self', 'r1', 'r2', 'r3'];

const DIV_KEYS_BY_COUNT = {
  1: ['self'],
  2: ['self', 'r3'],
  3: ['self', 'r1', 'r3'],
  4: ['self', 'r1', 'r2', 'r3'],
};

const WIND_KANJI = ['東', '南', '西', '北'];

const SEVEN_SEG = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abged',
  '3': 'abgcd',
  '4': 'fgbc',
  '5': 'afgcd',
  '6': 'afedcg',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
};

async function init() {
  if (!code || !/^\d{4}$/.test(code)) {
    alert('部屋番号が指定されていません。ホームから部屋を作成/参加してください。');
    location.replace('/xiama/home');
    return;
  }

  const res = await fetch('/api/me');

  if (!res.ok) {
    location.replace(
      '/login.html?redirect=' +
      encodeURIComponent('xiama/table?code=' + code)
    );
    return;
  }

  const statusRes = await fetch('/api/room/check/' + code);
  const status = await statusRes.json();

  if (!status.exists) {
    alert('その部屋は存在しません。');
    location.replace('/xiama/home');
    return;
  }

  connect();
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';

  ws = new WebSocket(
    `${proto}://${location.host}/ws/room/${code}`
  );

  ws.onmessage = (ev) => {
    reconnectAttempts = 0;

    const msg = JSON.parse(ev.data);

    if (msg.type === 'state') {
      render(msg);
    } else if (msg.type === 'ronPrompt') {
      showRonPrompt(msg.tile, msg.seat);
    } else if (msg.type === 'callPrompt') {
      showCallPrompt(msg.tile, msg.candidates, msg.seat);
    } else if (msg.type === 'canTsumo') {
      canTsumoNow = msg.possible;
      renderActionBar();
    } else if (msg.type === 'discardPreview') {
      if (msg.tileId === previewTileId) {
        previewData = msg;
        renderWaitPreview();
      }
    } else if (msg.type === 'announce') {
      showAnnounceBanner(msg);
    } else if (msg.type === 'notice') {
      // サーバーからの通知(リーチできない打牌を選んだ場合など)
      alert(msg.message);
    } else if (msg.type === 'result') {
      showResult(msg);
    } else if (msg.type === 'matchEnd') {
      // 結果画面の表示中なら、最後まで見終わってから対局結果を出す
      if (resultFlowActive) {
        pendingMatchEnd = msg;
      } else {
        showMatchEnd(msg);
      }
    }
  };

  ws.onclose = () => {
    reconnectAttempts += 1;

    if (reconnectAttempts > 5) {
      alert('サーバーとの接続に失敗しました。ホームに戻ります。');
      location.replace('/xiama/home');
      return;
    }

    setTimeout(connect, 2000);
  };
}

// ツモ牌(手番で引いた牌)を、手牌の並びの一番右に移す。
// ドラッグで手牌の途中に入れた直後は、動かさずにそのままにする。
let drawnTileManuallyPlaced = null;

function moveDrawnTileToEnd(drawnId) {
  if (!drawnId) return;
  if (drawnTileManuallyPlaced === drawnId) return;

  const i = handOrder.findIndex((t) => t.id === drawnId);
  if (i === -1 || i === handOrder.length - 1) return;

  const [t] = handOrder.splice(i, 1);
  handOrder.push(t);
}

function reconcileHandOrder(newTiles) {
  const remaining = [...newTiles];
  const kept = [];

  for (const oldTile of handOrder) {
    const idx = remaining.findIndex(
      (tile) => tile.id === oldTile.id
    );

    if (idx !== -1) {
      kept.push(oldTile);
      remaining.splice(idx, 1);
    }
  }

  remaining.sort((a, b) =>
    a.kind.localeCompare(b.kind)
  );

  handOrder = [...kept, ...remaining];
}


// ---------------------------------------------------------------
// 局・供託・本場・プロフィール画像・リーチ棒アニメーション
// ---------------------------------------------------------------

// 「東1局」のように、場風 + その風の中での局数。
// round は通算の局番号(1始まり)。1つの風は人数ぶんの局(4人なら東1〜東4)。
function roundLabel(s) {
  const n = Math.max(1, s.rules.playerCount);
  const idx = Math.max(0, (s.round || 1) - 1);
  const wind = WIND_KANJI[Math.floor(idx / n) % WIND_KANJI.length];
  const inWind = (idx % n) + 1;

  return `${wind}${inWind}局`;
}

// 左上のドラ表示の枠の下: [1000点棒] x 供託の本数 / [100点棒] x 本場数
function renderStickCounts(s) {
  const el = document.getElementById('stickCounts');
  if (!el) return;

  el.innerHTML = `
    <span class="stick-count">
      <span class="stick-1000 stick-icon"></span>
      <span class="stick-x">x ${s.riichiSticks || 0}</span>
    </span>
    <span class="stick-count">
      <span class="stick-100 stick-icon"></span>
      <span class="stick-x">x ${s.honba || 0}</span>
    </span>
  `;
}

function escapeHtmlText(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// プレイヤー名の上に出すプロフィール画像。未設定なら名前の1文字目の丸。
function avatarHtml(p) {
  if (p.avatarUrl) {
    return `<img class="player-avatar" src="${escapeHtmlText(p.avatarUrl)}" alt="">`;
  }

  const initial = escapeHtmlText(Array.from(p.username || '?')[0] || '?');
  return `<div class="player-avatar placeholder">${initial}</div>`;
}

// 席ごとの直前のリーチ状態(false→trueになった瞬間の検出用)と、飛んでいる間の印
const prevRiichi = {};
const riichiFlyingUntil = {};
const RIICHI_FLY_MS = 750;

const RIICHI_ORIENTATION = {
  self: { angle: 0,   dir: [0, 1] },   // 下の席: 画面の下から
  r1:   { angle: -90, dir: [1, 0] },   // 右の席: 画面の右から
  r2:   { angle: 180, dir: [0, -1] },  // 上の席: 画面の上から
  r3:   { angle: 90,  dir: [-1, 0] },  // 左の席: 画面の左から
};

// リーチ棒を画面外から飛ばして、そのプレイヤーのリーチ棒置き場に置く
function flyRiichiStick(divKey) {
  const slot = document.querySelector(`#compass-${divKey} .riichi-stick`);
  if (!slot) return;

  const { angle, dir } = RIICHI_ORIENTATION[divKey];

  const r = slot.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;

  const dist = Math.max(window.innerWidth, window.innerHeight) * 0.8 + 240;

  const el = document.createElement('div');
  el.className = 'stick-1000 riichi-fly';
  el.style.left = `${cx - 32}px`;
  el.style.top = `${cy - 5}px`;
  document.body.appendChild(el);

  const done = () => {
    el.remove();
    riichiFlyingUntil[divKey] = 0;

    // 再描画で作り直されている場合もあるので、今あるものを探して置く
    const now = document.querySelector(`#compass-${divKey} .riichi-stick`);
    if (now) now.classList.add('active');
  };

  if (!el.animate) {
    done();
    return;
  }

  const anim = el.animate(
    [
      {
        transform:
          `translate(${dir[0] * dist}px, ${dir[1] * dist}px) rotate(${angle + 540}deg) scale(2)`,
        opacity: 1,
      },
      {
        transform: `translate(0px, 0px) rotate(${angle}deg) scale(1)`,
        opacity: 1,
      },
    ],
    { duration: RIICHI_FLY_MS, easing: 'cubic-bezier(.2,.8,.25,1)', fill: 'forwards' }
  );

  anim.onfinish = done;
  anim.oncancel = done;
}

function render(s) {
  state = s;
  canTsumoNow = s.canTsumo === true;

  // 手番が自分から離れたら、リーチモードと待ちプレビューをリセットする
  const turnKey = `${s.handId}:${s.currentTurnSeat}`;
  if (turnKey !== lastTurnKey) {
    lastTurnKey = turnKey;
    if (s.currentTurnSeat !== s.yourSeat) {
      riichiMode = false;
      previewData = null;
      previewTileId = null;
    }
  }

  // 対局中でなくなったら、未回答のプロンプトは無効(局が終わっている)
  if (s.phase !== 'playing' && promptQueue.length > 0) {
    promptQueue = [];
    callPanelOpen = false;
    currentCallPrompt = null;
  }

  // 新しい局が始まったら、前の局の結果画面を閉じる
  if (
    resultFlowActive &&
    s.phase === 'playing' &&
    resultHandId !== null &&
    s.handId !== undefined &&
    s.handId !== resultHandId
  ) {
    hideResultOverlay();
  }

  const n = s.rules.playerCount;
  const my = s.yourSeat;

  renderDeadWall(s);
  renderStickCounts(s);

  const wallDigits = document.getElementById('wallDigits');

  if (wallDigits) {
    // 「東n局」(場風 + 局数)と、その下に残り牌数
    wallDigits.innerHTML =
      `<div class="round-label">${roundLabel(s)}</div>` +
      sevenSegNumber(s.wallRemaining, 2);
  }

  renderDevBar(s);

  if (my !== -1) {
    reconcileHandOrder([...s.yourHand]);
  }

  const activeDivKeys =
    DIV_KEYS_BY_COUNT[n] || DIV_KEYS_BY_COUNT[4];

  for (const divKey of SEAT_DIV_ORDER) {
    const seatEl =
      document.getElementById('seat-' + divKey);

    const riverEl =
      document.getElementById('river-' + divKey);

    const compassEl =
      document.getElementById('compass-' + divKey);

    const tagEl =
      document.getElementById('tag-' + divKey);

    const meldLayerEl =
      document.getElementById('meld-layer-' + divKey);

    const activeIdx =
      activeDivKeys.indexOf(divKey);

    if (activeIdx === -1) {
      [seatEl, riverEl, compassEl, tagEl, meldLayerEl].forEach((el) => {
        if (el) el.style.display = 'none';
      });

      continue;
    }

    if (seatEl) seatEl.style.display = 'flex';
    if (riverEl) riverEl.style.display = 'flex';
    if (compassEl) compassEl.style.display = 'flex';
    if (tagEl) tagEl.style.display = 'flex';
    if (meldLayerEl) meldLayerEl.style.display = '';

    /*
     * 自分を画面下側として、時計回りに
     *
     * self = 自分
     * r1   = 下家
     * r2   = 対面
     * r3   = 上家
     *
     * と対応させる。
     */
    const seatNum =
      my === -1
        ? activeIdx
        : (my + activeIdx) % n;

    const p = s.players[seatNum];

    if (!p) continue;

    const isDealer =
      seatNum === s.dealerSeat;

    const windIdx =
      (seatNum - s.dealerSeat + n) % n;

    if (tagEl) {
      tagEl.className =
        'player-tag corner-' +
        divKey +
        (p.riichi ? ' riichi' : '');

      tagEl.innerHTML =
        avatarHtml(p) +
        `<div class="player-name">` +
        `${isDealer ? '<span class="dealer-mark">親</span> ' : ''}` +
        `${escapeHtmlText(p.username)}${p.isCpu ? ' (CPU Lv' + (p.cpuStrength ?? 3) + ')' : ''}${divKey === 'self' && s.yourFuriten ? ' <span style="color:#ff8f8f; font-size:12px;">フリテン</span>' : ''}${p.connected ? '' : ' (切断)'}` +
        `</div>`;
    }

    if (compassEl) {
      compassEl.classList.toggle(
        'dealer',
        isDealer
      );

      // リーチ宣言の瞬間(false→true)だけ、リーチ棒を画面外から飛ばす。
      // 画面を開いた直後(前の状態が無い)に既にリーチしている人は、飛ばさずそのまま置く。
      const justRiichi =
        prevRiichi[seatNum] === false && p.riichi === true;

      if (justRiichi) {
        riichiFlyingUntil[divKey] = Date.now() + RIICHI_FLY_MS + 150;
      }

      prevRiichi[seatNum] = p.riichi;

      const flying =
        (riichiFlyingUntil[divKey] || 0) > Date.now();

      // 各プレイヤーから見て、風は左端、点数は中央(やや中心寄り)、リーチ棒はその外側。
      // 向きは .cell-* ごとに CSS で回転させる。
      compassEl.innerHTML = `
        <div class="cc-inner">
          <div class="wind">${WIND_KANJI[windIdx]}</div>
          <div class="score">${p.score}</div>
          <div class="riichi-slot">
            <div class="riichi-stick stick-1000 ${p.riichi && !flying ? 'active' : ''}"></div>
          </div>
        </div>
      `;

      if (justRiichi) {
        requestAnimationFrame(() => flyRiichiStick(divKey));
      }
    }

    const handEl =
      document.getElementById('hand-' + divKey);

    if (!handEl) continue;

    if (divKey === 'self') {
      const drawnId = state.yourDrawnTile?.id ?? null;
      const myRiichi = p.riichi === true;

      // ツモ牌を手牌の一番右に置く(再読み込み直後は牌が牌種順に並ぶため、
      // ツモ牌が途中に入り、間隔(14px)のぶん後ろの牌がずれて見えていた)
      moveDrawnTileToEnd(drawnId);

      const mainTiles = handOrder.map((tile, idx) =>
        tileHtml(
          tile.kind,
          tile.id === selectedTileId,
          true,
          false,
          idx,
          tile.id === drawnId && idx === handOrder.length - 1,
          tile.id,
          myRiichi && tile.id !== drawnId ? 'riichi-locked' : ''
        )
      );

      handEl.innerHTML = mainTiles.join('');

      attachHandHandlers(handEl);
    } else {
      // 開発者モード + ゴッドビューONなら、他プレイヤーの手牌も実際の牌で表示する
      const devHand = (s.devMode && devGodView && s.devAllHands)
        ? s.devAllHands.find((h) => h.seat === seatNum)
        : null;

      if (devHand) {
        handEl.innerHTML =
          devHand.hand
            .map((k) => tileHtml(k, false, false, true))
            .join('');
      } else {
        handEl.innerHTML =
          Array.from({ length: p.handCount })
            .map(() =>
              tileHtml(
                null,
                false,
                false,
                true
              )
            )
            .join('');
      }
    }

    if (riverEl) {
      riverEl.innerHTML =
        renderRiverTiles(p.discards);
    }

    const meldEl =
      document.getElementById(
        'meld-' + divKey
      );

    if (meldEl) {
      meldEl.innerHTML =
        p.melds
          .map((m) =>
            `<div class="meld-word">${
              meldDisplayTiles(m)
                .map((t) =>
                  tileHtml(
                    t.kind,
                    false,
                    false,
                    false,
                    undefined,
                    false,
                    undefined,
                    t.called ? 'meld-called' : ''
                  )
                )
                .join('')
            }</div>`
          )
          .join('');
    }
  }

  // 選択中の牌が手牌になくなったら、選択とプレビューを消す
  if (selectedTileId && !handOrder.some((tile) => tile.id === selectedTileId)) {
    selectedTileId = null;
    previewData = null;
    previewTileId = null;
  }

  renderActionBar();
  renderWaitPreview();
  renderDevWall(s);
  positionSelfHand();
  maybeAutoTsumogiri(s);
}

/*
 * 自分の手牌は卓の遠近法に乗せず、平面のまま表示する。
 * そのため卓(transform で台形に射影されている)の外に置き、
 * 卓の手前中央にある目印(#selfHandAnchor)の画面上の位置に合わせる。
 */
function positionSelfHand() {
  const anchor = document.getElementById('selfHandAnchor');
  const layer = document.getElementById('selfHandLayer');
  if (!anchor || !layer) return;

  const r = anchor.getBoundingClientRect();
  layer.style.left = (r.left + r.width / 2) + 'px';
  layer.style.top = r.bottom + 'px';
}

window.addEventListener('resize', positionSelfHand);
window.addEventListener('scroll', positionSelfHand, { passive: true });
window.addEventListener('load', positionSelfHand);

/*
 * 鳴いてできた単語を、単語の文字順に並べた牌リストにする。
 * サーバーから来る m.tiles は [鳴いた牌, 手牌から出した牌...] の順なので、
 * そのままだと単語として読めない。鳴いた牌(tiles[0])と同じ文字のうち
 * 単語中で最初のものを「鳴いた牌」として called: true にする(横向きに表示)。
 * 文字が噛み合わない場合は元の順序のまま、先頭を鳴いた牌として扱う。
 */
function meldDisplayTiles(m) {
  const kinds = m.tiles.slice();
  const pool = kinds.slice();
  const ordered = [];
  let calledAssigned = false;
  let ok = true;

  for (const ch of Array.from(m.word)) {
    const i = pool.indexOf(ch);
    if (i === -1) { ok = false; break; }
    pool.splice(i, 1);
    const isCalled = !calledAssigned && ch === kinds[0];
    if (isCalled) calledAssigned = true;
    ordered.push({ kind: ch, called: isCalled });
  }

  if (!ok || pool.length > 0) {
    return kinds.map((k, i) => ({ kind: k, called: i === 0 }));
  }
  return ordered;
}

function tileHtml(kind, selected, selectable, small, idx, isDrawn, tileId, wrapClass) {
  const cls = ['tile'];

  if (small) cls.push('small');
  if (!kind) cls.push('back');
  if (selected) cls.push('selected');
  if (isDrawn) cls.push('drawn-tile');

  const dataAttrs = selectable
    ? `data-kind="${kind}"
       data-idx="${idx}"
       data-tile-id="${tileId || ''}"
       ${isDrawn ? 'data-drawn="1"' : ''}
       draggable="true"`
    : '';

  /*
   * 牌1枚を6面の3Dオブジェクトとして生成する。
   *
   * .tile-front は既存の .tile をそのまま利用するため、
   * クリック・ドラッグ・選択などの既存処理は変更しない。
   *
   * .tile-wrap は牌の「入れ物」。座席自体の回転(rotate)は
   * 受け継ぐが、.tile3d 自身が持つ追加のrotateX/perspectiveは
   * 受け継がない。増殖(box-shadowの層)はこの .tile-wrap に
   * 付けることで、牌1枚分の四角い形のまま奥に重なるようにする。
   */
  return `
    <div class="tile-wrap${wrapClass ? ' ' + wrapClass : ''}">
      <div class="tile3d">
        <div class="${cls.join(' ')} tile-front" ${dataAttrs}>${kind || ''}</div>
        <div class="tile-face tile-back"></div>
        <div class="tile-face tile-left"></div>
        <div class="tile-face tile-right"></div>
        <div class="tile-face tile-top"></div>
        <div class="tile-face tile-bottom"></div>
        <div class="tile-face tile-s tile-sb" style="--i:1"></div>
        <div class="tile-face tile-s tile-sb" style="--i:2"></div>
        <div class="tile-face tile-s tile-sb" style="--i:3"></div>
        <div class="tile-face tile-s tile-sb" style="--i:4"></div>
        <div class="tile-face tile-s tile-sb" style="--i:5"></div>
        <div class="tile-face tile-s tile-sb" style="--i:6"></div>
        <div class="tile-face tile-s tile-sb" style="--i:7"></div>
        <div class="tile-face tile-s tile-sf" style="--i:8"></div>
        <div class="tile-face tile-s tile-sf" style="--i:9"></div>
        <div class="tile-face tile-s tile-sf" style="--i:10"></div>
        <div class="tile-face tile-s tile-sf" style="--i:11"></div>
        <div class="tile-face tile-s tile-sf" style="--i:12"></div>
        <div class="tile-face tile-s tile-sf" style="--i:13"></div>
        <div class="tile-face tile-s tile-sf" style="--i:14"></div>
      </div>
    </div>
  `;
}

// 王牌(嶺上牌を除く10枚)を卓の外に表示する。
// ドラ表示牌(表になっている分)は実際の牌で、残りは裏向きで表示する。
function renderDeadWall(s) {
  const el = document.getElementById('deadWallTiles');
  if (!el) return;
  const TOTAL = 5; // 王牌の表側5枚(裏ドラは和了時にしかめくられないので表示しない)
  const revealed = s.doraIndicators || [];
  const tiles = [];
  for (let i = 0; i < TOTAL; i++) {
    if (i < revealed.length) {
      tiles.push(tileHtml(revealed[i], false, false, true));
    } else {
      tiles.push(tileHtml(null, false, false, true));
    }
  }
  el.innerHTML = tiles.join('');
}

// ---------- 開発者モード UI ----------
function renderDevBar(s) {
  const bar = document.getElementById('devBar');
  if (!bar) return;
  if (!s.devMode) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');

  const select = document.getElementById('devSeatSelect');
  if (!select) return;
  const options = (s.devSeats || []).map((seatNum) => {
    const p = s.players[seatNum];
    const label = `${seatNum === s.currentTurnSeat ? '▶ ' : ''}席${seatNum + 1}: ${p ? p.username : ''}`;
    return `<option value="${seatNum}">${label}</option>`;
  }).join('');
  const prevSelected = select.value;
  select.innerHTML = options;
  if ([...select.options].some((o) => o.value === prevSelected)) select.value = prevSelected;
}

function renderDevWall(s) {
  const modal = document.getElementById('wallModal');
  const tilesEl = document.getElementById('devWallTiles');
  const statusEl = document.getElementById('devWallStatus');

  if (!modal || !tilesEl || !statusEl) return;

  if (!s.devMode || !devWallVisible || !s.devWall) {
    modal.classList.add('hidden');
    return;
  }

  const history = s.devWall.history || [];
  const future = s.devWall.future || [];

  statusEl.textContent =
    `消費済み ${history.length}枚 / 残り ${future.length}枚 / ` +
    `合計 ${s.devWall.total || history.length + future.length}枚`;

  let html = '';

  // 既に消費された牌
  for (const kind of history) {
    html += `
      <div class="dev-wall-tile used">${kind}</div>
    `;
  }

  // 現在位置
  html += `
    <div class="dev-wall-divider"></div>
  `;

  // これからツモる牌
  for (const kind of future) {
    html += `
      <div class="dev-wall-tile future">${kind}</div>
    `;
  }

  tilesEl.innerHTML = html;
  modal.classList.remove('hidden');
}

function updateDebugPanel() {
  if (!state) return;
  const seatSel = document.getElementById('devSeatSelect');
  const inspectSeat = seatSel && seatSel.value !== '' ? Number(seatSel.value) : null;
  let inspect = null;
  if (inspectSeat !== null && state.devAllHands) {
    const handEntry = state.devAllHands.find((h) => h.seat === inspectSeat);
    const p = state.players[inspectSeat];
    inspect = {
      seat: inspectSeat,
      username: p?.username,
      hand: handEntry?.hand,
      discards: p?.discards,
      melds: p?.melds,
      riichi: p?.riichi,
      score: p?.score,
    };
  }
  const jsonEl = document.getElementById('debugJson');
  if (jsonEl) jsonEl.textContent = JSON.stringify({ inspectSeat: inspect, state }, null, 2);
}

document.getElementById('devGodView')?.addEventListener('change', (e) => {
  devGodView = e.target.checked;
  if (state) render(state);
});
document.getElementById('devWallToggle')?.addEventListener('click', () => {
  if (!state || !state.devMode) return;

  devWallVisible = !devWallVisible;

  const button = document.getElementById('devWallToggle');

  if (button) {
    button.textContent = devWallVisible
      ? '山を閉じる'
      : '山を見る';
  }

  renderDevWall(state);
});

document.getElementById('devWallClose')?.addEventListener('click', () => {
  devWallVisible = false;

  const button = document.getElementById('devWallToggle');

  if (button) {
    button.textContent = '山を見る';
  }

  document.getElementById('wallModal')?.classList.add('hidden');
});
document.getElementById('devSeatSelect')?.addEventListener('change', updateDebugPanel);
document.getElementById('devDebugToggle')?.addEventListener('click', () => {
  updateDebugPanel();
  document.getElementById('debugModal')?.classList.remove('hidden');
});

function attachHandHandlers(handEl) {
  handEl.onclick = (e) => {
    // ロン・鳴きの確認中は打牌できない(確認中に切れると進行が壊れる)。
    // 確認する側はアクションバーのボタンで回答する。
    if (state?.awaitingDecisions) return;

    const wraps = [
      ...handEl.querySelectorAll('.tile-wrap')
    ];

    if (wraps.length === 0) return;

    let nearest = null;
    let nearestDistance = Infinity;

    for (const wrap of wraps) {
      const rect = wrap.getBoundingClientRect();

      const centerX =
        rect.left + rect.width / 2;

      const centerY =
        rect.top + rect.height / 2;

      const dx = e.clientX - centerX;
      const dy = e.clientY - centerY;

      const distance =
        dx * dx + dy * dy;

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = wrap;
      }
    }

    if (!nearest) return;

    const el =
      nearest.querySelector('.tile[data-kind]');

    if (!el) return;

    const tileId = el.dataset.tileId;

    // リーチした後は、ツモ牌以外は選べない(切れない)
    const myRiichi = state && state.yourSeat !== -1 && state.players[state.yourSeat]?.riichi === true;
    const drawnId = state?.yourDrawnTile?.id ?? null;
    if (myRiichi && tileId !== drawnId) return;

    if (el.classList.contains('selected')) {
      selectedTileId = tileId;
      doDiscard();
      return;
    }

    handEl
      .querySelectorAll('.tile')
      .forEach((t) =>
        t.classList.remove('selected')
      );

    el.classList.add('selected');

    selectedTileId = tileId;

    // リーチボタンが押された状態で牌を選んだら、その牌を切った場合の待ちを表示する
    if (riichiMode) {
      requestPreview(tileId);
    } else {
      previewData = null;
      previewTileId = null;
      renderWaitPreview();
    }
  };

  const tiles = [...handEl.querySelectorAll('.tile[data-kind]')];

  tiles.forEach((el) => {
    const wrap = el.closest('.tile-wrap');

    if (!wrap) return;
    const tileId = el.dataset.tileId;
    const isDrawn = el.dataset.drawn === '1';

    wrap.draggable = true;
    wrap.ondragstart = (e) => {
      dragFromIdx = isDrawn ? 'drawn' : Number(el.dataset.idx);
      e.dataTransfer.effectAllowed = 'move';
    };

    wrap.ondragover = (e) => {
      e.preventDefault();
      el.classList.add('drop-target');
    };

    wrap.ondragleave = () => {
      el.classList.remove('drop-target');
    };

    wrap.ondrop = (e) => {
      e.preventDefault();
      el.classList.remove('drop-target');

      if (dragFromIdx === null) return;

      const toIdx = Number(el.dataset.idx);

      let moved;

      if (dragFromIdx === 'drawn') {
        const drawnId = state.yourDrawnTile?.id;

        if (!drawnId) {
          dragFromIdx = null;
          return;
        }

        const fromIdx = handOrder.findIndex(
          (tile) => tile.id === drawnId
        );

        if (fromIdx === -1) {
          dragFromIdx = null;
          return;
        }

        moved = handOrder.splice(fromIdx, 1)[0];
      } else {
        moved = handOrder.splice(dragFromIdx, 1)[0];
      }

      if (!moved) {
        dragFromIdx = null;
        return;
      }

      const insertAt = Math.min(toIdx, handOrder.length);
      handOrder.splice(insertAt, 0, moved);

      // ツモ牌を自分で手牌の途中に入れたときは、次の描画で右端に戻さない
      if (moved.id === state?.yourDrawnTile?.id) {
        drawnTileManuallyPlaced = moved.id;
      }

      dragFromIdx = null;
      renderHandOnly();
    };
  });
}

function getClickedHandTile(handEl, clientX, clientY) {
  const wraps = [
    ...handEl.querySelectorAll('.tile-wrap')
  ];

  if (wraps.length === 0) return null;

  let best = null;
  let bestDist = Infinity;

  for (const wrap of wraps) {
    const rect = wrap.getBoundingClientRect();

    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const dx = clientX - cx;
    const dy = clientY - cy;

    const dist = dx * dx + dy * dy;

    if (dist < bestDist) {
      bestDist = dist;
      best = wrap;
    }
  }

  return best;
}

function renderHandOnly() {
  if (!state) return;

  const handEl = document.getElementById('hand-self');
  if (!handEl) return;

  const drawnId = state?.yourDrawnTile?.id ?? null;
  const myRiichi = state?.yourSeat !== -1 && state?.players[state.yourSeat]?.riichi === true;

  const mainTiles = handOrder.map((tile, idx) =>
    tileHtml(
      tile.kind,
      tile.id === selectedTileId,
      true,
      false,
      idx,
      // ツモ牌が一番右にあるときだけ、手牌との間隔をあける
      tile.id === drawnId && idx === handOrder.length - 1,
      tile.id,
      myRiichi && tile.id !== drawnId ? 'riichi-locked' : ''
    )
  );

  handEl.innerHTML = mainTiles.join('');

  attachHandHandlers(handEl);
}

function canDeclareRiichi() {
  if (!state || state.yourSeat === -1) {
    return false;
  }

  return state.canRiichi === true;
}

function doDiscard() {
  if (!selectedTileId) return;
  if (!state) return;
  if (state.awaitingDecisions) return;

  // リーチ宣言中は、切ればテンパイになる牌だけ切れる(サーバーが送る riichiDiscards)
  if (riichiMode) {
    const picked = handOrder.find((t) => t.id === selectedTileId);
    const allowed = state.riichiDiscards || [];

    if (picked && !allowed.includes(picked.kind)) {
      alert(
        'その牌を切ってもテンパイにならないため、リーチできません。\n' +
        (allowed.length
          ? `リーチできる打牌: ${allowed.join('　')}`
          : '')
      );
      return;
    }
  }

  ws.send(
    JSON.stringify({
      type: 'discard',
      tileId: selectedTileId,
      riichi: riichiMode,
      seat: state.yourSeat,
    })
  );

  selectedTileId = null;
  riichiMode = false;
  previewData = null;
  previewTileId = null;
  renderWaitPreview();
}

function renderActionBar() {
  const bar =
    document.getElementById('actionBar');

  if (!bar) return;

  // ロン/鳴きのプロンプト表示中はそちらを優先する。
  // (state更新のたびに renderActionBar が呼ばれるため、ここで上書きしないと
  //  プロンプトが消えて回答できなくなる)
  if (promptQueue.length > 0) {
    showNextPrompt();
    return;
  }

  bar.innerHTML = '';

  if (!state || state.yourSeat === -1) {
    return;
  }

  const isMyTurn =
    state.currentTurnSeat ===
    state.yourSeat;

  if (!isMyTurn) return;

  const myRiichi =
    state.players[state.yourSeat]?.riichi === true;

  // リーチした後は、引いた牌であがれるときだけ「ツモ」「ツモ切り」の
  // 選択を出す。あがれないときは自動でツモ切りする。
  if (myRiichi) {
    if (!canTsumoNow) return;

    const tsumoBtn =
      document.createElement('button');

    tsumoBtn.className =
      'btn primary';

    tsumoBtn.textContent = 'ツモ';

    tsumoBtn.onclick = () =>
      ws.send(
        JSON.stringify({
          type: 'tsumoWin',
          seat: state.yourSeat,
        })
      );

    bar.appendChild(tsumoBtn);

    const tsumogiriBtn =
      document.createElement('button');

    tsumogiriBtn.className = 'btn';
    tsumogiriBtn.textContent = 'ツモ切り';

    tsumogiriBtn.onclick = () => {
      const drawnId = state.yourDrawnTile?.id;
      if (!drawnId) return;
      selectedTileId = drawnId;
      doDiscard();
    };

    bar.appendChild(tsumogiriBtn);
    return;
  }

  if (canDeclareRiichi()) {
    const riichiBtn =
      document.createElement('button');

    riichiBtn.className =
      'btn' +
      (riichiMode ? ' primary' : '');

    riichiBtn.textContent = 'リーチ';

    riichiBtn.onclick = () => {
      riichiMode = !riichiMode;
      if (riichiMode && selectedTileId) {
        // リーチボタンを押したときに牌が選択されていたら、待ちを表示する
        requestPreview(selectedTileId);
      } else {
        previewData = null;
        previewTileId = null;
        renderWaitPreview();
      }
      renderActionBar();
    };

    bar.appendChild(riichiBtn);
  }

  if (canTsumoNow) {
    const tsumoBtn =
      document.createElement('button');

    tsumoBtn.className =
      'btn primary';

    tsumoBtn.textContent = 'ツモ';

    tsumoBtn.onclick = () =>
      ws.send(
        JSON.stringify({
          type: 'tsumoWin',
          seat: state.yourSeat,
        })
      );

    bar.appendChild(tsumoBtn);
  }
}

// 選んだ牌を切った場合の待ちをサーバーに問い合わせる
function requestPreview(tileId) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!state) return;
  previewTileId = tileId;
  previewData = null;
  ws.send(
    JSON.stringify({
      type: 'previewDiscard',
      tileId,
      seat: state.yourSeat,
    })
  );
  renderWaitPreview();
}

// 待ちプレビューの表示。待ちの牌は牌で表示し、その下に残り枚数を出す。
// その牌を切るとフリテンになる場合は、待ちの上にフリテンと表示する。
function renderWaitPreview() {
  const el =
    document.getElementById('waitPreview');

  if (!el) return;

  if (
    !riichiMode ||
    !selectedTileId ||
    !previewData ||
    previewData.tileId !== selectedTileId
  ) {
    el.innerHTML = '';
    el.classList.add('hidden');
    return;
  }

  el.classList.remove('hidden');

  const waits = previewData.waits || [];

  if (waits.length === 0) {
    el.innerHTML =
      '<div class="wait-warning">この牌を切るとテンパイが崩れるため、リーチできません</div>';
    return;
  }

  el.innerHTML =
    (previewData.furiten
      ? '<div class="furiten-label">フリテン</div>'
      : '') +
    '<div class="wait-tiles">' +
    waits
      .map(
        (w) =>
          `<div class="wait-tile-col">${tileHtml(
            w.kind,
            false,
            false,
            true
          )}<div class="wait-count">残り${w.remaining}枚</div></div>`
      )
      .join('') +
    '</div>';
}

// リーチした後、引いた牌であがれないときは自動でツモ切りする。
// (開発者モードでは、確認中の席が勝手に切れてしまうので自動化しない)
function maybeAutoTsumogiri(s) {
  if (!s || s.devMode) return;
  if (s.phase !== 'playing') return;
  if (s.awaitingDecisions) return;

  const my = s.yourSeat;
  if (my === -1 || s.currentTurnSeat !== my) return;

  const me = s.players[my];
  if (!me || !me.riichi) return;
  if (canTsumoNow) return; // あがれるときは自分で選ぶ
  if (promptQueue.length > 0) return;

  const drawn = s.yourDrawnTile;
  if (!drawn) return;

  const key = `${s.handId}:${drawn.id}`;
  if (autoTsumogiriKey === key) return;
  autoTsumogiriKey = key;

  setTimeout(() => {
    if (!state || state.phase !== 'playing') return;
    if (state.awaitingDecisions) return;
    if (state.currentTurnSeat !== state.yourSeat) return;
    if (!state.players[state.yourSeat]?.riichi) return;
    if (canTsumoNow) return;
    if (promptQueue.length > 0) return;
    if (state.yourDrawnTile?.id !== drawn.id) return;
    selectedTileId = drawn.id;
    doDiscard();
  }, 800);
}

function showRonPrompt(tile, forSeat) {
  enqueuePrompt({ kind: 'ron', tile, seat: forSeat });
}

function showCallPrompt(tile, candidates, forSeat) {
  enqueuePrompt({ kind: 'call', tile, candidates, seat: forSeat });
}

// 開発者モードでは複数の席を同時に持つため、ロン/鳴きのプロンプトが同時に複数来ることがある。
// 1つずつ順番に表示するキューを介する。
let promptQueue = [];
function enqueuePrompt(p) {
  promptQueue.push(p);
  if (promptQueue.length === 1) showNextPrompt();
}
function showNextPrompt() {
  if (promptQueue.length === 0) { renderActionBar(); return; }
  const p = promptQueue[0];
  if (p.kind === 'ron') showRonPromptInner(p.tile, p.seat);
  else showCallPromptInner(p.tile, p.candidates, p.seat);
}
function dequeueAndShowNext() {
  promptQueue.shift();
  showNextPrompt();
}

function showRonPromptInner(tile, forSeat) {
  const bar =
    document.getElementById('actionBar');

  bar.innerHTML = '';

  const wrap =
    document.createElement('div');

  wrap.className = 'panel';
  wrap.style.padding = '14px 20px';

  const seatLabel = (state && state.devMode && forSeat !== undefined) ? `(席${forSeat + 1}) ` : '';
  wrap.innerHTML =
    `<span style="margin-right:12px;">${seatLabel}「${tile}」でロンできます</span>`;

  const yes =
    document.createElement('button');

  yes.className =
    'btn primary';

  yes.textContent = 'ロン';

  yes.onclick = () => {
    ws.send(
      JSON.stringify({
        type: 'ronDecision',
        accept: true,
        seat: forSeat !== undefined ? forSeat : state.yourSeat,
      })
    );

    dequeueAndShowNext();
  };

  const no =
    document.createElement('button');

  no.className = 'btn';
  no.textContent = 'スルー';

  no.onclick = () => {
    ws.send(
      JSON.stringify({
        type: 'ronDecision',
        accept: false,
        seat: forSeat !== undefined ? forSeat : state.yourSeat,
      })
    );

    dequeueAndShowNext();
  };

  wrap.appendChild(yes);
  wrap.appendChild(no);

  bar.appendChild(wrap);
}

function showCallPromptInner(
  tile,
  candidates,
  forSeat
) {
  currentCallPrompt = { tile, candidates, seat: forSeat };

  const bar =
    document.getElementById('actionBar');

  if (!bar) return;

  bar.innerHTML = '';

  const wrap =
    document.createElement('div');

  wrap.className = 'panel call-prompt-panel';

  // 「鳴く」を押すと、ボタンの上に鳴けるパターンの枠が出る
  if (callPanelOpen) {
    const panel =
      document.createElement('div');

    panel.className = 'call-panel';

    for (const c of candidates) {
      const row =
        document.createElement('button');

      row.className = 'call-candidate';
      row.innerHTML =
        `<span class="call-word-tiles">${[...c.word]
          .map((ch) => tileHtml(ch, false, false, true))
          .join('')}</span>` +
        `<span class="call-han">${c.han === 'y' ? '役満' : c.han + '翻'}</span>`;

      row.onclick = () => respondCall(true, c.word);

      panel.appendChild(row);
    }

    wrap.appendChild(panel);
  }

  const row =
    document.createElement('div');

  row.className = 'call-prompt-row';

  const seatLabel = (state && state.devMode && forSeat !== undefined) ? `(席${forSeat + 1}) ` : '';

  const label =
    document.createElement('span');

  label.textContent = `${seatLabel}「${tile}」で鳴けます`;

  const callBtn =
    document.createElement('button');

  callBtn.className =
    'btn' + (callPanelOpen ? ' primary' : '');

  callBtn.textContent = '鳴く';

  callBtn.onclick = () => {
    callPanelOpen = !callPanelOpen;
    showCallPromptInner(tile, candidates, forSeat);
  };

  const skipBtn =
    document.createElement('button');

  skipBtn.className = 'btn';
  skipBtn.textContent = 'スキップ';

  skipBtn.onclick = () => respondCall(false);

  row.appendChild(label);
  row.appendChild(callBtn);
  row.appendChild(skipBtn);

  wrap.appendChild(row);
  bar.appendChild(wrap);
}

function respondCall(
  accept,
  word
) {
  const prompt = currentCallPrompt;

  const seat =
    prompt && prompt.seat !== undefined
      ? prompt.seat
      : state.yourSeat;

  ws.send(
    JSON.stringify({
      type: 'callDecision',
      accept,
      word,
      seat,
    })
  );

  callPanelOpen = false;
  currentCallPrompt = null;

  dequeueAndShowNext();
}

// ---------------------------------------------------------------
// 鳴き・ツモ・ロンの帯(アナウンス)
// ---------------------------------------------------------------

let bannerTimer = null;

function showBanner(html, ms) {
  const el =
    document.getElementById('announceBanner');

  if (!el) return;

  el.innerHTML = html;
  el.classList.remove('hidden');

  // アニメーションを最初から再生し直す
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');

  if (bannerTimer) clearTimeout(bannerTimer);

  bannerTimer = setTimeout(
    () => el.classList.add('hidden'),
    ms
  );
}

// 鳴きの帯: プレイヤー名・アイコン・鳴いた単語(牌)と翻数
function showAnnounceBanner(msg) {
  const p =
    state?.players[msg.seat] || {
      username: msg.username || '',
    };

  const label = msg.isKan ? 'カン' : '鳴き';

  const wordHtml = msg.word
    ? `<span class="announce-word">${[...msg.word]
        .map((ch) => tileHtml(ch, false, false, true))
        .join('')}</span>` +
      `<span class="announce-han">${msg.han === 'y' ? '役満' : msg.han + '翻'}</span>`
    : '';

  showBanner(
    `<div class="announce-inner">${avatarHtml(p)}` +
      `<div class="announce-name">${escapeHtmlText(p.username)}</div>` +
      `<div class="announce-label">${label}</div>${wordHtml}</div>`,
    1800
  );
}

// ツモ・ロンの帯: プレイヤー名・アイコンとともに大きく表示する
function showWinBanner(msg) {
  const winners =
    msg.kind === 'tsumo'
      ? [msg.winner]
      : (msg.results || []).map((r) => r.winner);

  const label = msg.kind === 'tsumo' ? 'ツモ' : 'ロン';

  const names = winners
    .map((seat) => {
      const p = state?.players[seat] || { username: '' };
      return (
        `<div class="announce-inner">${avatarHtml(p)}` +
        `<div class="announce-name">${escapeHtmlText(p.username)}</div>` +
        `<div class="announce-label">${label}</div></div>`
      );
    })
    .join('');

  showBanner(names, 2200);
}

// ---------------------------------------------------------------
// 結果画面(あがり詳細 → 点数の移動 → 次局への準備)
// ---------------------------------------------------------------

function showResult(msg) {
  // 未回答のプロンプトは無効(局が終わっている)
  promptQueue = [];
  callPanelOpen = false;
  currentCallPrompt = null;

  resultFlowActive = true;
  resultHandId = msg.handId ?? null;
  currentResultMsg = msg;
  readySent = false;

  if (msg.kind === 'draw') {
    renderResultDetail(msg);
    return;
  }

  // 帯を出してから、詳細画面に切り替える
  showWinBanner(msg);

  setTimeout(() => {
    if (currentResultMsg === msg && resultFlowActive) {
      renderResultDetail(msg);
    }
  }, 2200);
}

function hideResultOverlay() {
  const overlay =
    document.getElementById('resultOverlay');

  if (overlay) overlay.classList.add('hidden');

  resultFlowActive = false;
  resultHandId = null;
  currentResultMsg = null;
  readySent = false;
}

function renderResultDetail(msg) {
  const card =
    document.getElementById('resultCard');

  if (!card) return;

  if (msg.kind === 'draw') {
    card.innerHTML = drawDetailHtml(msg);
  } else {
    card.innerHTML = winDetailHtml(msg);
  }

  document
    .getElementById('resultOverlay')
    .classList.remove('hidden');

  const nextBtn =
    document.getElementById('resultNextBtn');

  if (nextBtn) {
    nextBtn.onclick = () =>
      renderScoreMoveStep(currentResultMsg);
  }
}

function winDetailHtml(msg) {
  const winners =
    msg.kind === 'tsumo'
      ? [
          {
            winner: msg.winner,
            decomp: msg.decomp,
            score: msg.score,
            handInfo: msg.handInfo,
            winningTile: msg.winningTile,
            winnerRiichi: msg.winnerRiichi,
          },
        ]
      : msg.results;

  const title = msg.kind === 'tsumo' ? 'ツモ' : 'ロン';

  return (
    `<h2 class="result-title">${title}</h2>` +
    winners
      .map((w) => winnerCardHtml(w, msg))
      .join('') +
    `<button class="btn primary result-next" id="resultNextBtn">次へ</button>`
  );
}

function winnerCardHtml(w, msg) {
  const p = state?.players[w.winner];
  const name = p ? escapeHtmlText(p.username) : '';

  const handInfo = w.handInfo || { hand: [], melds: [] };

  // 和了牌は手牌の最後に分けて表示する。ツモの場合は手牌に含まれているので1枚抜く。
  const dispHand = [...(handInfo.hand || [])];
  if (
    dispHand.length === 14 &&
    w.winningTile
  ) {
    const i = dispHand.indexOf(w.winningTile);
    if (i !== -1) dispHand.splice(i, 1);
  }

  const handTiles = dispHand
    .map((k) => tileHtml(k, false, false, true))
    .join('');

  const winTile = w.winningTile
    ? tileHtml(
        w.winningTile,
        false,
        false,
        true,
        undefined,
        false,
        undefined,
        'winning-tile'
      )
    : '';

  const melds = (handInfo.melds || [])
    .map(
      (m) =>
        `<div class="meld-word">${m.tiles
          .map((k) => tileHtml(k, false, false, true))
          .join('')}</div>`
    )
    .join('');

  const dora = (msg.doraTiles || [])
    .map((k) => tileHtml(k, false, false, true))
    .join('');

  // 裏ドラは、リーチしていない場合は5枚ともめくられていない状態で表示する
  const ura = (msg.uraTiles || [])
    .map((k) =>
      w.winnerRiichi
        ? tileHtml(k, false, false, true)
        : tileHtml(null, false, false, true)
    )
    .join('');

  const breakdown = (w.score.baseHanBreakdown || [])
    .map((b) => breakdownRowHtml(b, w.decomp))
    .join('');

  const pay = w.score.payments;
  const payText =
    msg.kind === 'tsumo'
      ? pay.fromDealer
        ? `親から${pay.fromDealer}点・子から${pay.fromNonDealer}点`
        : `全員から${pay.fromNonDealer}点`
      : `放銃者から${pay.total}点`;

  const big = w.score.limitName
    ? `${w.score.limitName} ${pay.total}点`
    : `${pay.total}点`;

  return `<div class="win-card">
    <div class="win-head">${p ? avatarHtml(p) : ''}<span>${name} の和了</span></div>
    <div class="win-hand">${handTiles}<span class="win-tile-gap"></span>${winTile}</div>
    ${melds ? `<div class="win-melds">${melds}</div>` : ''}
    <div class="dora-row"><span class="dora-label">ドラ</span>${dora}</div>
    <div class="dora-row"><span class="dora-label">裏ドラ</span>${ura}</div>
    <div class="breakdown">${breakdown}</div>
    <div class="han-fu-line">${w.score.han}翻 ${w.score.fu}符</div>
    <div class="big-points">${big}</div>
    <div class="pay-text">${payText}</div>
  </div>`;
}

// 役分解の1行。単語は牌で表示し、それぞれの翻数も出す。
function breakdownRowHtml(b, decomp) {
  const isWord =
    decomp &&
    decomp.words &&
    decomp.words.includes(b.label);

  const labelHtml = isWord
    ? `<span class="breakdown-word">${[...b.label]
        .map((ch) => tileHtml(ch, false, false, true))
        .join('')}</span>`
    : `<span class="breakdown-label">${escapeHtmlText(b.label)}</span>`;

  const hanText = b.han === 'y' ? '役満' : `${b.han}翻`;

  return `<div class="breakdown-row">${labelHtml}<span class="breakdown-han">${hanText}</span></div>`;
}

function drawDetailHtml(msg) {
  const reasonText =
    msg.reason === 'four-riichi'
      ? '四家立直'
      : msg.reason === 'four-kan'
        ? '四槓散了'
        : '牌切れ';

  const rows = (msg.players || [])
    .map((pl) => {
      const p = state?.players[pl.seat];
      const hand = (pl.hand || [])
        .map((k) => tileHtml(k, false, false, true))
        .join('');
      const melds = (pl.melds || [])
        .map(
          (m) =>
            `<div class="meld-word">${m.tiles
              .map((k) => tileHtml(k, false, false, true))
              .join('')}</div>`
        )
        .join('');
      const waits =
        pl.tenpai && pl.waits && pl.waits.length > 0
          ? `<span class="draw-waits">待ち: ${pl.waits
              .map((k) => tileHtml(k, false, false, true))
              .join('')}</span>`
          : '';

      return `<div class="draw-row">
        <div class="draw-head">${p ? avatarHtml(p) : ''}<span>${escapeHtmlText(
          pl.username
        )}</span><span class="tenpai-label ${
          pl.tenpai ? 'is-tenpai' : 'is-noten'
        }">${pl.tenpai ? 'テンパイ' : 'ノーテン'}</span></div>
        <div class="win-hand">${hand}</div>
        ${melds ? `<div class="win-melds">${melds}</div>` : ''}
        ${waits}
      </div>`;
    })
    .join('');

  return (
    `<h2 class="result-title">流局</h2><p>${reasonText}</p>` +
    rows +
    `<button class="btn primary result-next" id="resultNextBtn">次へ</button>`
  );
}

// 点数の移動の表示。「次局への準備OK」を全員が押すと次の局が始まる。
function renderScoreMoveStep(msg) {
  const card =
    document.getElementById('resultCard');

  if (!card) return;

  const rows = (msg.scoreChanges || [])
    .map((sc) => {
      const delta = sc.after - sc.before;
      const deltaText =
        delta > 0 ? `+${delta}` : `${delta}`;
      const p = state?.players[sc.seat];

      return `<div class="score-move-row">${p ? avatarHtml(p) : ''}` +
        `<span class="score-move-name">${escapeHtmlText(sc.username)}</span>` +
        `<span class="score-move-nums">${sc.before}点 → ${sc.after}点</span>` +
        `<span class="score-move-delta ${
          delta > 0 ? 'plus' : delta < 0 ? 'minus' : ''
        }">${deltaText}</span></div>`;
    })
    .join('');

  let action = '';

  if (msg.hasNextHand) {
    action =
      !state || state.yourSeat === -1
        ? '<div class="ready-wait-text">対局者が次の局の準備をしています…</div>'
        : '<button class="btn primary" id="resultReadyBtn">次局への準備OK</button>';
  } else if (pendingMatchEnd) {
    action =
      '<button class="btn primary" id="resultMatchEndBtn">対局結果を見る</button>';
  } else {
    action =
      `<button class="btn primary" onclick="location.href='/xiama/home'">ホームへ</button>`;
  }

  card.innerHTML =
    `<h2 class="result-title">点数の移動</h2>` + rows + action;

  const readyBtn =
    document.getElementById('resultReadyBtn');

  if (readyBtn) {
    readyBtn.onclick = sendReadyForNextHand;
  }

  const matchEndBtn =
    document.getElementById('resultMatchEndBtn');

  if (matchEndBtn) {
    matchEndBtn.onclick = () => {
      const m = pendingMatchEnd;
      pendingMatchEnd = null;
      showMatchEnd(m);
    };
  }
}

function sendReadyForNextHand() {
  if (readySent) return;
  readySent = true;

  const btn =
    document.getElementById('resultReadyBtn');

  if (btn) {
    btn.disabled = true;
    btn.textContent = '他のプレイヤーを待っています…';
  }

  // 開発者モードで複数席を持っている場合は、全席まとめて準備OKにする
  if (
    state?.devMode &&
    (state.devSeats || []).length > 1
  ) {
    ws.send(JSON.stringify({ type: 'devReadyAll' }));
  } else {
    ws.send(
      JSON.stringify({
        type: 'ready',
        ready: true,
        seat: state.yourSeat,
      })
    );
  }
}

function showMatchEnd(msg) {
  resultFlowActive = false;
  resultHandId = null;
  currentResultMsg = null;
  readySent = false;

  const card =
    document.getElementById(
      'resultCard'
    );

  const sorted =
    [...msg.finalScores]
      .sort(
        (a, b) =>
          b.score - a.score
      );

  card.innerHTML =
    `<h2>対局終了${msg.reason === 'tobi' ? '（飛び）' : ''}</h2>` +
    (msg.reason === 'tobi'
      ? `<div style="color:var(--text-sub); font-size:13px; margin-bottom:8px;">持ち点がマイナスになったため、対局終了しました。</div>`
      : '') +
    sorted
      .map(
        (p, i) =>
          `<div>${i + 1}位: ${p.username} (${p.score}点)</div>`
      )
      .join('') +
    `
      <button
        class="btn primary"
        style="margin-top:16px;"
        onclick="location.href='/xiama/home'"
      >
        ホームへ
      </button>
    `;

  document
    .getElementById(
      'resultOverlay'
    )
    .classList.remove(
      'hidden'
    );
}

function digitHtml(ch) {
  const segs =
    SEVEN_SEG[ch] || '';

  const all = [
    'a',
    'b',
    'c',
    'd',
    'e',
    'f',
    'g',
  ];

  return `
    <div class="digit">
      ${all
        .map(
          (seg) =>
            `<div class="seg seg-${seg} ${
              segs.includes(seg)
                ? 'on'
                : ''
            }"></div>`
        )
        .join('')}
    </div>
  `;
}

function renderRiverTiles(discards) {
  const blocks = [];

  const blockWidth =
    'calc(6 * var(--tile-w) + 5 * var(--tile-gap))';

  for (let i = 0; i < discards.length; i += 30) {
    const block = discards.slice(i, i + 30);
    const blockIndex = i / 30;

    blocks.push(`
      <div
        class="river-block"
        style="left: calc(${blockIndex} * ${blockWidth});"
      >
        ${block
          .map((k) =>
            tileHtml(
              k,
              false,
              false,
              true
            )
          )
          .join('')}
      </div>
    `);
  }

  return blocks.join('');
}

function sevenSegNumber(
  n,
  minDigits
) {
  const str =
    String(Math.max(0, n))
      .padStart(
        minDigits || 1,
        '0'
      );

  return `
    <div class="digit-group">
      ${[...str]
        .map(digitHtml)
        .join('')}
    </div>
  `;
}

init();