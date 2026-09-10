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
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afedcg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
};

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function sevenSegDigit(d) {
  const on = SEVEN_SEG[d] || '';
  return `<span class="seven-seg">${[...'abcdefg'].map(x =>
    `<i class="seg seg-${x}${on.includes(x) ? ' on' : ''}"></i>`).join('')}</span>`;
}

function sevenSegNumber(n, width = 2) {
  const s = String(Math.max(0, n | 0)).padStart(width, '0');
  return `<span class="seven-seg-number">${[...s].map(sevenSegDigit).join('')}</span>`;
}

function tileHtml(tile, extra = '') {
  if (!tile) return '';
  const cls = ['tile', extra];
  if (tile.small) cls.push('small');
  if (tile.back) cls.push('back');
  if (tile.id === selectedTileId) cls.push('selected');
  if (tile.drawn) cls.push('drawn-tile');
  const label = tile.back ? '' : escapeHtml(tile.kind || tile.name || '');
  return `<div class="${cls.join(' ')}" data-tile-id="${escapeHtml(tile.id)}">${label}</div>`;
}

function mySeat() {
  return state?.yourSeat ?? -1;
}

/*
 * Visual seat mapping:
 *   self = 自分
 *   r1   = 南（自分から見て上家側）
 *   r2   = 西（対面）
 *   r3   = 北（自分から見て下家側）
 *
 * The server advances turns by +1 seat, so r1 is the next seat.
 */
function seatForDiv(divKey) {
  const n = state?.playerCount || 4;
  const my = mySeat();
  const idx = DIV_KEYS_BY_COUNT[n]?.indexOf(divKey) ?? -1;
  if (idx < 0 || my < 0) return -1;
  const keys = DIV_KEYS_BY_COUNT[n];
  const activeIdx = keys.indexOf(divKey);
  if (activeIdx < 0) return -1;
  return (my + activeIdx) % n;
}

function playerForSeat(seat) {
  return state?.players?.find(p => p.seat === seat) || null;
}

function renderPlayers() {
  for (const key of SEAT_DIV_ORDER) {
    const el = $(`seat-${key}`);
    if (!el) continue;
    const seat = seatForDiv(key);
    const p = playerForSeat(seat);
    if (!p) {
      el.innerHTML = '';
      continue;
    }
    const active = state.currentTurnSeat === seat;
    el.classList.toggle('active-turn', active);
    el.innerHTML = `
      <div class="player-name">${escapeHtml(p.name)}</div>
      <div class="player-score">${Number(p.score ?? 0).toLocaleString()}</div>
      <div class="player-hand" data-seat="${seat}">${renderHand(p, seat)}</div>
    `;
  }
}

function renderHand(p, seat) {
  const isSelf = seat === mySeat();
  if (!isSelf) {
    const count = p.hand?.length ?? p.handCount ?? 13;
    return Array.from({ length: count }, () => tileHtml({ id: 'back', back: true }, 'opponent-tile')).join('');
  }

  const hand = p.hand || [];
  return hand.map((t, i) => {
    const extra = (i === hand.length - 1 && hand.length % 3 === 2) ? 'drawn-tile' : '';
    return tileHtml(t, extra);
  }).join('');
}

function renderRiver(p, key) {
  const el = $(`river-${key}`);
  if (!el) return;
  const river = p?.river || p?.discards || [];
  el.innerHTML = river.map(t => tileHtml(t, 'river-tile')).join('');
  el.style.pointerEvents = 'none';
}

function renderRivers() {
  for (const key of SEAT_DIV_ORDER) {
    const seat = seatForDiv(key);
    renderRiver(playerForSeat(seat), key);
  }
}

function renderCompass() {
  const el = $('compass');
  if (!el) return;
  const dealer = Number(state?.dealerSeat ?? 0);
  const roundWind = WIND_KANJI[Number(state?.roundWind ?? 0) % 4] || '東';
  const turnSeat = Number(state?.currentTurnSeat ?? -1);

  el.innerHTML = `
    <div class="compass-center">
      <div class="round-wind">${roundWind}</div>
      <div class="wall-count" id="wallDigits">
        <div class="wall-label">残り</div>
        ${sevenSegNumber(state?.wallRemaining ?? state?.wall?.length ?? 0, 2)}
      </div>
    </div>
    <div class="compass-dir compass-north">${WIND_KANJI[(dealer + 3) % 4]}</div>
    <div class="compass-dir compass-east">${WIND_KANJI[dealer % 4]}</div>
    <div class="compass-dir compass-south">${WIND_KANJI[(dealer + 1) % 4]}</div>
    <div class="compass-dir compass-west">${WIND_KANJI[(dealer + 2) % 4]}</div>
    <div class="compass-turn">手番: ${turnSeat >= 0 ? escapeHtml(playerForSeat(turnSeat)?.name || '') : ''}</div>
  `;
}

function canDeclareRiichi() {
  return Array.isArray(state?.riichiDiscards) &&
    state.riichiDiscards.length > 0 &&
    !playerForSeat(mySeat())?.riichi;
}

function renderActionBar() {
  const bar = $('actionBar');
  if (!bar) return;

  const my = playerForSeat(mySeat());
  const myTurn = state?.currentTurnSeat === mySeat();

  const riichiButton = canDeclareRiichi() && myTurn
    ? `<button id="riichiBtn" class="btn">立直</button>` : '';

  const tsumoButton = canTsumoNow && myTurn
    ? `<button id="tsumoBtn" class="btn">ツモ</button>` : '';

  bar.innerHTML = `${tsumoButton}${riichiButton}`;

  $('riichiBtn')?.addEventListener('click', () => {
    riichiMode = !riichiMode;
    $('riichiBtn')?.classList.toggle('selected', riichiMode);
  });

  $('tsumoBtn')?.addEventListener('click', () => {
    send({ type: 'tsumo' });
  });
}

function doDiscard(tileId) {
  if (!state || state.currentTurnSeat !== mySeat()) return;
  const p = playerForSeat(mySeat());
  if (!p) return;

  const tile = (p.hand || []).find(t => t.id === tileId);
  if (!tile) return;

  if (riichiMode) {
    const allowed = state.riichiDiscards || [];
    if (!allowed.includes(tile.kind)) {
      alert('その牌を切って立直することはできません。');
      return;
    }
  }

  send({
    type: 'discard',
    tileId,
    riichiDeclare: riichiMode,
  });
  selectedTileId = null;
  riichiMode = false;
}

function attachHandEvents() {
  document.querySelectorAll('.player-hand[data-seat]').forEach(handEl => {
    const seat = Number(handEl.dataset.seat);
    if (seat !== mySeat()) return;

    handEl.querySelectorAll('.tile[data-tile-id]').forEach(tileEl => {
      tileEl.addEventListener('click', () => {
        const id = tileEl.dataset.tileId;
        if (selectedTileId === id) {
          doDiscard(id);
        } else {
          selectedTileId = id;
          render();
        }
      });

      tileEl.draggable = true;
      tileEl.addEventListener('dragstart', e => {
        dragFromIdx = [...handEl.children].indexOf(tileEl);
        e.dataTransfer?.setData('text/plain', String(dragFromIdx));
      });

      tileEl.addEventListener('dragover', e => e.preventDefault());
      tileEl.addEventListener('drop', e => {
        e.preventDefault();
        const from = Number(e.dataTransfer?.getData('text/plain'));
        const to = [...handEl.children].indexOf(tileEl);
        if (!Number.isInteger(from) || from < 0 || to < 0 || from === to) return;

        const p = playerForSeat(mySeat());
        if (!p?.hand) return;
        const moved = p.hand.splice(from, 1)[0];
        p.hand.splice(to, 0, moved);
        render();
      });
    });
  });
}

function render() {
  if (!state) return;
  renderPlayers();
  renderRivers();
  renderCompass();
  renderActionBar();
  attachHandEvents();

  const table = $('table');
  if (table) {
    table.classList.toggle('my-turn', state.currentTurnSeat === mySeat());
  }
}

function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function connect() {
  if (!code) return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?code=${encodeURIComponent(code)}`);

  ws.addEventListener('open', () => {
    reconnectAttempts = 0;
  });

  ws.addEventListener('message', e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') {
        state = msg.state;
        render();
      } else if (msg.type === 'error') {
        alert(msg.message || 'エラー');
      }
    } catch (err) {
      console.error(err);
    }
  });

  ws.addEventListener('close', () => {
    const delay = Math.min(10000, 500 * (2 ** reconnectAttempts++));
    setTimeout(connect, delay);
  });

  ws.addEventListener('error', () => {
    try { ws.close(); } catch {}
  });
}

document.addEventListener('DOMContentLoaded', () => {
  connect();
});