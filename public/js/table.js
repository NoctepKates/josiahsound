const code = new URLSearchParams(location.search).get('code');
let ws = null;
let state = null;
let selectedTileId = null;
let riichiMode = false;
let canTsumoNow = false;
let reconnectAttempts = 0;
let dragFromIdx = null;

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
  ws = new WebSocket(`${proto}://${location.host}/ws/room/${code}`);

  ws.onmessage = (ev) => {
    reconnectAttempts = 0;

    const msg = JSON.parse(ev.data);

    if (msg.type === 'state') render(msg);
    else if (msg.type === 'ronPrompt') showRonPrompt(msg.tile);
    else if (msg.type === 'callPrompt') showCallPrompt(msg.tile, msg.candidates);
    else if (msg.type === 'canTsumo') {
      canTsumoNow = msg.possible;
      renderActionBar();
    }
    else if (msg.type === 'result') showResult(msg);
    else if (msg.type === 'matchEnd') showMatchEnd(msg);
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

function reconcileHandOrder(newKinds) {
  const remaining = [...newKinds];
  const kept = [];

  for (const k of handOrder) {
    const idx = remaining.indexOf(k);

    if (idx !== -1) {
      kept.push(k);
      remaining.splice(idx, 1);
    }
  }

  remaining.sort();
  handOrder = [...kept, ...remaining];
}

function render(s) {
  state = s;
  canTsumoNow = false;

  const n = s.players?.length || 0;
  const my = s.yourSeat ?? -1;

  if (my >= 0 && s.players?.[my]) {
    const kinds = s.players[my].hand || [];
    reconcileHandOrder(kinds);
  }

  const activeKeys = DIV_KEYS_BY_COUNT[n] || SEAT_DIV_ORDER;

  for (const divKey of SEAT_DIV_ORDER) {
    const seatEl = document.getElementById('seat-' + divKey);
    const riverEl = document.getElementById('river-' + divKey);

    if (!seatEl) continue;

    if (!activeKeys.includes(divKey)) {
      seatEl.style.display = 'none';

      if (riverEl) {
        riverEl.style.display = 'none';
      }

      continue;
    }

    seatEl.style.display = '';
    if (riverEl) riverEl.style.display = '';

    let activeIdx = SEAT_DIV_ORDER.indexOf(divKey);
    let seatNum;

    if (my === -1) {
      seatNum = activeIdx;
    } else {
      seatNum = (my + activeIdx) % n;
    }

    const p = s.players[seatNum];
    if (!p) continue;

    const isDealer = seatNum === s.dealerSeat;
    const windIdx = (seatNum - s.dealerSeat + n) % n;

    const tagEl = document.getElementById('tag-' + divKey);

    if (tagEl) {
      tagEl.className =
        'player-tag corner-' +
        divKey +
        (p.riichi ? ' riichi' : '');

      tagEl.innerHTML =
        `${isDealer ? '<span class="dealer-mark">親</span> ' : ''}` +
        `${p.username}${p.connected ? '' : ' (切断)'}`;
    }

    const compassEl = document.getElementById('compass-' + divKey);

    if (compassEl) {
      compassEl.classList.toggle('dealer', isDealer);

      compassEl.innerHTML = `
        <div class="wind">${WIND_KANJI[windIdx]}</div>
        <div class="score">${p.score}</div>
        <div class="riichi-stick ${p.riichi ? 'active' : ''}"></div>
      `;
    }

    const handEl = document.getElementById('hand-' + divKey);

    if (divKey === 'self') {
      const mainTiles = handOrder.map((kind, idx) =>
        tileHtml(
          kind,
          kind === selectedTileId,
          true,
          false,
          idx
        )
      );

      const drawnKind = s.yourDrawnTile;

      const drawnTileHtml = drawnKind
        ? tileHtml(
            drawnKind,
            drawnKind === selectedTileId &&
              !handOrder.includes(selectedTileId),
            true,
            false,
            -1,
            true
          )
        : '';

      handEl.innerHTML =
        mainTiles.join('') +
        drawnTileHtml;

      attachHandHandlers(handEl);
    } else {
      handEl.innerHTML = Array.from({
        length: p.handCount
      })
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

    if (riverEl) {
      riverEl.innerHTML = p.discards
        .map((k) =>
          tileHtml(
            k,
            false,
            false,
            true
          )
        )
        .join('');
    }

    const meldEl = document.getElementById('meld-' + divKey);

    meldEl.innerHTML = p.melds
      .map((m) =>
        `<div style="display:flex; gap:2px;">${
          m.tiles
            .map((k) =>
              tileHtml(
                k,
                false,
                false
              )
            )
            .join('')
        }</div>`
      )
      .join('');
  }

  renderActionBar();
}

function tileHtml(
  kind,
  selected,
  selectable,
  small,
  idx,
  isDrawn
) {
  const cls = ['tile'];

  if (small) cls.push('small');
  if (!kind) cls.push('back');
  if (selected) cls.push('selected');
  if (isDrawn) cls.push('drawn-tile');

  const dataAttrs = selectable
    ? `data-kind="${kind}" data-idx="${idx}" ${
        isDrawn ? 'data-drawn="1"' : ''
      } draggable="true"`
    : '';

  return `<div class="${cls.join(' ')}" ${dataAttrs}>${kind || ''}</div>`;
}

function attachHandHandlers(handEl) {
  const tiles = [
    ...handEl.querySelectorAll('.tile[data-kind]')
  ];

  tiles.forEach((el) => {
    const kind = el.dataset.kind;
    const isDrawn =
      el.dataset.drawn === '1';

    el.onclick = () => {
      if (el.classList.contains('selected')) {
        selectedTileId = kind;
        doDiscard();
        return;
      }

      handEl
        .querySelectorAll('.tile')
        .forEach((t) =>
          t.classList.remove('selected')
        );

      el.classList.add('selected');
      selectedTileId = kind;
    };

    el.ondragstart = (e) => {
      dragFromIdx = isDrawn
        ? 'drawn'
        : Number(el.dataset.idx);

      e.dataTransfer.effectAllowed = 'move';
    };

    el.ondragover = (e) => {
      e.preventDefault();
      el.classList.add('drop-target');
    };

    el.ondragleave = () => {
      el.classList.remove('drop-target');
    };

    el.ondrop = (e) => {
      e.preventDefault();
      el.classList.remove('drop-target');

      const toIdx = isDrawn
        ? handOrder.length
        : Number(el.dataset.idx);

      if (dragFromIdx === null) return;

      let moved;

      if (dragFromIdx === 'drawn') {
        moved = state.yourDrawnTile;
      } else {
        moved = handOrder.splice(
          dragFromIdx,
          1
        )[0];
      }

      const insertAt = Math.min(
        toIdx,
        handOrder.length
      );

      handOrder.splice(
        insertAt,
        0,
        moved
      );

      dragFromIdx = null;

      renderHandOnly();
    };
  });
}

function renderHandOnly() {
  if (!state) return;

  const handEl =
    document.getElementById('hand-self');

  handEl.innerHTML = handOrder
    .map((kind, idx) =>
      tileHtml(
        kind,
        kind === selectedTileId,
        true,
        false,
        idx
      )
    )
    .join('');

  attachHandHandlers(handEl);
}

function canDeclareRiichi() {
  if (!state || state.yourSeat === -1) {
    return false;
  }

  const me =
    state.players[state.yourSeat];

  if (
    !me ||
    me.riichi ||
    me.melds.length > 0 ||
    me.score < 1000
  ) {
    return false;
  }

  if (state.wallRemaining < 4) {
    return false;
  }

  return Array.isArray(state.riichiDiscards) &&
    state.riichiDiscards.length > 0;
}

function renderActionBar() {
  const bar =
    document.getElementById('actionBar');

  if (!bar) return;

  const my =
    state?.players?.[state?.yourSeat];

  const myTurn =
    state?.currentTurnSeat === state?.yourSeat;

  const riichiButton =
    canDeclareRiichi() && myTurn
      ? `<button id="riichiBtn" class="btn">立直</button>`
      : '';

  const tsumoButton =
    canTsumoNow && myTurn
      ? `<button id="tsumoBtn" class="btn">ツモ</button>`
      : '';

  bar.innerHTML =
    `${tsumoButton}${riichiButton}`;

  document
    .getElementById('riichiBtn')
    ?.addEventListener('click', () => {
      riichiMode = !riichiMode;

      document
        .getElementById('riichiBtn')
        ?.classList.toggle(
          'selected',
          riichiMode
        );
    });

  document
    .getElementById('tsumoBtn')
    ?.addEventListener('click', () => {
      send({
        type: 'tsumo'
      });
    });
}

function doDiscard() {
  if (
    !state ||
    state.currentTurnSeat !== state.yourSeat
  ) {
    return;
  }

  const p =
    state.players[state.yourSeat];

  if (!p) return;

  const tile =
    (p.hand || []).find(
      t => t.id === selectedTileId
    );

  if (!tile) return;

  if (riichiMode) {
    const allowed =
      state.riichiDiscards || [];

    if (!allowed.includes(tile.kind)) {
      alert(
        'その牌を切って立直することはできません。'
      );
      return;
    }
  }

  send({
    type: 'discard',
    tileId: selectedTileId,
    riichiDeclare: riichiMode
  });

  selectedTileId = null;
  riichiMode = false;
}

function send(obj) {
  if (
    ws &&
    ws.readyState === WebSocket.OPEN
  ) {
    ws.send(JSON.stringify(obj));
  }
}

function mySeat() {
  return state?.yourSeat ?? -1;
}

function playerForSeat(seat) {
  return (
    state?.players?.find(
      p => p.seat === seat
    ) || null
  );
}

function seatForDiv(divKey) {
  const n =
    state?.players?.length || 0;

  const my = mySeat();

  if (my < 0) {
    return SEAT_DIV_ORDER.indexOf(divKey);
  }

  const offset =
    SEAT_DIV_ORDER.indexOf(divKey);

  return (my + offset) % n;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function sevenSegNumber(num, digits = 2) {
  const s =
    String(Math.max(0, Number(num) || 0))
      .padStart(digits, '0');

  return `
    <div class="digit-group">
      ${[...s].map(ch => `
        <div class="digit">
          ${[
            'a','b','c','d','e','f','g'
          ].map(seg =>
            `<span class="seg seg-${seg} ${
              SEVEN_SEG[ch]?.includes(seg)
                ? 'on'
                : ''
            }"></span>`
          ).join('')}
        </div>
      `).join('')}
    </div>
  `;
}

function renderCompass() {
  const el =
    document.getElementById('compass');

  if (!el) return;

  const dealer =
    Number(state?.dealerSeat ?? 0);

  const roundWind =
    WIND_KANJI[
      Number(state?.roundWind ?? 0) % 4
    ] || '東';

  const turnSeat =
    Number(
      state?.currentTurnSeat ?? -1
    );

  el.innerHTML = `
    <div class="compass-center">
      <div class="round-wind">
        ${roundWind}
      </div>

      <div class="wall-count" id="wallDigits">
        <div class="wall-label">
          残り
        </div>

        ${sevenSegNumber(
          state?.wallRemaining ??
          state?.wall?.length ??
          0,
          2
        )}
      </div>
    </div>

    <div class="compass-dir compass-north">
      ${WIND_KANJI[(dealer + 3) % 4]}
    </div>

    <div class="compass-dir compass-east">
      ${WIND_KANJI[dealer % 4]}
    </div>

    <div class="compass-dir compass-south">
      ${WIND_KANJI[(dealer + 1) % 4]}
    </div>

    <div class="compass-dir compass-west">
      ${WIND_KANJI[(dealer + 2) % 4]}
    </div>

    <div class="compass-turn">
      手番:
      ${
        turnSeat >= 0
          ? escapeHtml(
              playerForSeat(turnSeat)?.name || ''
            )
          : ''
      }
    </div>
  `;
}

function showRonPrompt(tile) {
  // 既存のロン処理
}

function showCallPrompt(tile, candidates) {
  // 既存の鳴き処理
}

function showResult(msg) {
  // 既存の結果表示処理
}

function showMatchEnd(msg) {
  // 既存の試合終了処理
}

init();