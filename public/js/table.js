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

async function init() {
  if (!code || !/^\d{4}$/.test(code)) {
    alert('部屋番号が指定されていません。ホームから部屋を作成/参加してください。');
    location.replace('/xiama/home');
    return;
  }
  const res = await fetch('/api/me');
  if (!res.ok) { location.replace('/login.html?redirect=' + encodeURIComponent('xiama/table?code=' + code)); return; }

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
    else if (msg.type === 'canTsumo') { canTsumoNow = msg.possible; renderActionBar(); }
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
    if (idx !== -1) { kept.push(k); remaining.splice(idx, 1); }
  }
  remaining.sort();
  handOrder = [...kept, ...remaining];
}

function render(s) {
  state = s;
  canTsumoNow = false;
  const n = s.rules.playerCount;
  const my = s.yourSeat;

  document.getElementById('roundInfo').textContent =
    `第${s.round}局 (${s.honba}本場) / ドラ表示: ${s.doraIndicators.join(' ')}`;
  document.getElementById('wallDigits').innerHTML = sevenSegNumber(s.wallRemaining, 2);

  let drawnKind = null;
  if (my !== -1) {
    const hand = [...s.yourHand];
    if (s.yourDrawnTile) {
      const idx = hand.lastIndexOf(s.yourDrawnTile);
      if (idx !== -1) { drawnKind = hand.splice(idx, 1)[0]; }
    }
    reconcileHandOrder(hand);
  }

  const activeDivKeys = DIV_KEYS_BY_COUNT[n] || DIV_KEYS_BY_COUNT[4];

  for (const divKey of SEAT_DIV_ORDER) {
    const seatEl = document.getElementById('seat-' + divKey);
    const riverEl = document.getElementById('river-' + divKey);
    const compassEl = document.getElementById('compass-' + divKey);
    const tagEl = document.getElementById('tag-' + divKey);
    const activeIdx = activeDivKeys.indexOf(divKey);

    if (activeIdx === -1) {
      [seatEl, riverEl, compassEl, tagEl].forEach((el) => { if (el) el.style.display = 'none'; });
      continue;
    }
    if (seatEl) seatEl.style.display = 'flex';
    if (riverEl) riverEl.style.display = 'grid';
    if (compassEl) compassEl.style.display = 'flex';
    if (tagEl) tagEl.style.display = 'flex';

    // 画面上の「右側(r1)」を下家とする。
    // 座席番号は時計回りではなく、プレイヤーの次番が (seat - 1) になるため、
    // 自分視点では r1=一つ前のseat、r2=二つ前、r3=三つ前にする。
    const seatNum = my === -1 ? activeIdx : (my - activeIdx + n) % n;
    const p = s.players[seatNum];
    if (!p) continue;

    const isDealer = seatNum === s.dealerSeat;
    const windIdx = (seatNum - s.dealerSeat + n) % n;

    tagEl.className = 'player-tag corner-' + divKey + (p.riichi ? ' riichi' : '');
    tagEl.innerHTML = `${isDealer ? '<span class="dealer-mark">親</span> ' : ''}${p.username}${p.connected ? '' : ' (切断)'}`;

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
      const mainTiles = handOrder.map((kind, idx) => tileHtml(kind, kind === selectedTileId, true, false, idx));
      const drawnTileHtml = drawnKind
        ? tileHtml(drawnKind, drawnKind === selectedTileId && !handOrder.includes(selectedTileId), true, false, -1, true)
        : '';
      handEl.innerHTML = mainTiles.join('') + drawnTileHtml;
      attachHandHandlers(handEl);
    } else {
      handEl.innerHTML = Array.from({ length: p.handCount })
        .map(() => tileHtml(null, false, false, true)).join('');
    }

    if (riverEl) {
      riverEl.innerHTML = p.discards.map((k) => tileHtml(k, false, false, true)).join('');
    }

    const meldEl = document.getElementById('meld-' + divKey);
    meldEl.innerHTML = p.melds.map((m) =>
      `<div style="display:flex; gap:2px;">${m.tiles.map((k) => tileHtml(k, false, false)).join('')}</div>`
    ).join('');
  }

  renderActionBar();
}

function tileHtml(kind, selected, selectable, small, idx, isDrawn) {
  const cls = ['tile'];
  if (small) cls.push('small');
  if (!kind) cls.push('back');
  if (selected) cls.push('selected');
  if (isDrawn) cls.push('drawn-tile');
  const dataAttrs = selectable
    ? `data-kind="${kind}" data-idx="${idx}" ${isDrawn ? 'data-drawn="1"' : ''} draggable="true"`
    : '';
  return `<div class="${cls.join(' ')}" ${dataAttrs}>${kind || ''}</div>`;
}

function attachHandHandlers(handEl) {
  const tiles = [...handEl.querySelectorAll('.tile[data-kind]')];
  tiles.forEach((el) => {
    const kind = el.dataset.kind;
    const isDrawn = el.dataset.drawn === '1';

    el.onclick = () => {
      if (el.classList.contains('selected')) {
        selectedTileId = kind;
        doDiscard();
        return;
      }
      handEl.querySelectorAll('.tile').forEach((t) => t.classList.remove('selected'));
      el.classList.add('selected');
      selectedTileId = kind;
    };

    el.ondragstart = (e) => {
      dragFromIdx = isDrawn ? 'drawn' : Number(el.dataset.idx);
      e.dataTransfer.effectAllowed = 'move';
    };
    el.ondragover = (e) => { e.preventDefault(); el.classList.add('drop-target'); };
    el.ondragleave = () => { el.classList.remove('drop-target'); };
    el.ondrop = (e) => {
      e.preventDefault();
      el.classList.remove('drop-target');
      const toIdx = isDrawn ? handOrder.length : Number(el.dataset.idx);
      if (dragFromIdx === null) return;

      let moved;
      if (dragFromIdx === 'drawn') {
        moved = state.yourDrawnTile;
      } else {
        moved = handOrder.splice(dragFromIdx, 1)[0];
      }
      const insertAt = Math.min(toIdx, handOrder.length);
      handOrder.splice(insertAt, 0, moved);
      dragFromIdx = null;
      renderHandOnly();
    };
  });
}

function renderHandOnly() {
  if (!state) return;
  const handEl = document.getElementById('hand-self');
  handEl.innerHTML = handOrder.map((kind, idx) =>
    tileHtml(kind, kind === selectedTileId, true, false, idx)
  ).join('');
  attachHandHandlers(handEl);
}

// サーバーが riichiDiscards を送る版ではそれを使用する。
// 未対応サーバーでもボタン自体は表示できるようにフォールバックするが、
// 実際のリーチ成立条件は必ずサーバー側で検証する。
function canDeclareRiichi() {
  if (!state || state.yourSeat === -1) return false;
  const me = state.players[state.yourSeat];
  if (!me || me.riichi || me.melds.length > 0 || me.score < 1000) return false;
  if (state.wallRemaining < 4) return false;
  return Array.isArray(state.riichiDiscards) && state.riichiDiscards.length > 0;
}

function doDiscard() {
  if (!selectedTileId) return;

  if (riichiMode) {
    const legal = Array.isArray(state?.riichiDiscards) && state.riichiDiscards.includes(selectedTileId);
    if (!legal) {
      alert('その牌を切ってもテンパイにならないため、リーチできません。');
      return;
    }
  }

  ws.send(JSON.stringify({ type: 'discard', tileId: selectedTileId, riichi: riichiMode }));
  selectedTileId = null;
  riichiMode = false;
}

function renderActionBar() {
  const bar = document.getElementById('actionBar');
  bar.innerHTML = '';
  if (!state || state.yourSeat === -1) return;
  const isMyTurn = state.currentTurnSeat === state.yourSeat;
  if (!isMyTurn) return;

  if (canDeclareRiichi()) {
    const riichiBtn = document.createElement('button');
    riichiBtn.className = 'btn' + (riichiMode ? ' primary' : '');
    riichiBtn.textContent = 'リーチ';
    riichiBtn.onclick = () => { riichiMode = !riichiMode; renderActionBar(); };
    bar.appendChild(riichiBtn);
  }

  if (canTsumoNow) {
    const tsumoBtn = document.createElement('button');
    tsumoBtn.className = 'btn primary';
    tsumoBtn.textContent = 'ツモ';
    tsumoBtn.onclick = () => ws.send(JSON.stringify({ type: 'tsumoWin' }));
    bar.appendChild(tsumoBtn);
  }
}

function showRonPrompt(tile) {
  const bar = document.getElementById('actionBar');
  bar.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'panel';
  wrap.style.padding = '14px 20px';
  wrap.innerHTML = `<span style="margin-right:12px;">「${tile}」でロンできます</span>`;
  const yes = document.createElement('button');
  yes.className = 'btn primary'; yes.textContent = 'ロン';
  yes.onclick = () => { ws.send(JSON.stringify({ type: 'ronDecision', accept: true })); bar.innerHTML = ''; };
  const no = document.createElement('button');
  no.className = 'btn'; no.textContent = 'スルー';
  no.onclick = () => { ws.send(JSON.stringify({ type: 'ronDecision', accept: false })); bar.innerHTML = ''; };
  wrap.appendChild(yes); wrap.appendChild(no);
  bar.appendChild(wrap);
}

function showCallPrompt(tile, candidates) {
  document.getElementById('callModal').classList.remove('hidden');
  document.getElementById('callCandidates').innerHTML = candidates.map((c) => `
    <button class="btn primary" onclick="respondCall(true, '${c.word}')">${c.word}（${c.han}翻）で鳴く</button>
  `).join('');
}
function respondCall(accept, word) {
  ws.send(JSON.stringify({ type: 'callDecision', accept, word }));
  document.getElementById('callModal').classList.add('hidden');
}

function showResult(msg) {
  const card = document.getElementById('resultCard');
  if (msg.kind === 'draw') {
    card.innerHTML = `<h2>流局</h2><p>${msg.reason === 'four-riichi' ? '四家立直' : '牌切れ'}</p>`;
  } else if (msg.kind === 'tsumo') {
    card.innerHTML = renderWinCard('ツモ', [{ decomp: msg.decomp, score: msg.score, winner: msg.winner }], state);
  } else {
    card.innerHTML = renderWinCard('ロン', msg.results, state);
  }
  document.getElementById('resultOverlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('resultOverlay').classList.add('hidden'), 6000);
}

function renderWinCard(title, results, s) {
  return `<h2>${title}</h2>` + results.map((r) => {
    const winnerName = s.players[r.winner]?.username || '';
    return `
      <div style="margin-bottom:16px; border-bottom:1px solid var(--border); padding-bottom:12px;">
        <div>${winnerName} の和了</div>
        <div class="word-list">${r.decomp.words.map((w) => `<span class="word-chip">${w}</span>`).join('')}</div>
        <div class="han-fu">${r.score.han}翻 ${r.score.fu}符${r.score.limitName ? ' (' + r.score.limitName + ')' : ''}</div>
        <div>${r.score.payments.total}点</div>
      </div>
    `;
  }).join('');
}

function showMatchEnd(msg) {
  const card = document.getElementById('resultCard');
  const sorted = [...msg.finalScores].sort((a, b) => b.score - a.score);
  card.innerHTML = `<h2>対局終了</h2>` + sorted.map((p, i) => `<div>${i + 1}位: ${p.username} (${p.score}点)</div>`).join('')
    + `<button class="btn primary" style="margin-top:16px;" onclick="location.href='/xiama/home'">ホームへ</button>`;
  document.getElementById('resultOverlay').classList.remove('hidden');
}

function digitHtml(ch) {
  const segs = SEVEN_SEG[ch] || '';
  const all = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  return `<div class="digit">${all.map((seg) => `<div class="seg seg-${seg} ${segs.includes(seg) ? 'on' : ''}></div>`).join('')}</div>`;
}
function sevenSegNumber(n, minDigits) {
  const str = String(Math.max(0, n)).padStart(minDigits || 1, '0');
  return `<div class="digit-group">${[...str].map(digitHtml).join('')}</div>`;
}

init();
