const code = new URLSearchParams(location.search).get('code');
let ws = null;
let state = null;
let selectedTileId = null;
let riichiMode = false;
let canTsumoNow = false;
let reconnectAttempts = 0;
let dragFromIdx = null;

// 自分の手牌の表示順(ドラッグ並び替えの結果を保持するため、サーバーから来る配列を
// そのまま毎回描画に使わず、この配列を「表示上の真実」として持ち回す)
let handOrder = [];

const SEAT_DIV_ORDER = ['self', 'r1', 'r2', 'r3']; // 自分から見て 自分/下家/対面/上家
// 人数ごとに、どの座席枠(div)を使うか。
// 2人打ちでは相手を「左」に、3人打ちでは「右・左」に配置し、対面(上)は使わない。
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

// ---------- 手牌の表示順管理(ドラッグ並び替え対応) ----------
// ツモ牌(yourDrawnTile)は除いた「持ち手13枚相当」の並びだけをhandOrderで管理する。
// サーバーの最新情報(counts)と突き合わせて、既存の並びをできる限り維持しつつ
// 増減分だけを反映する。
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

  // 自分の手牌: ツモ牌を1枚分離し、残りをhandOrderで管理する
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

    const seatNum = my === -1 ? activeIdx : (my + activeIdx) % n;
    const p = s.players[seatNum];
    if (!p) continue;

    const isDealer = seatNum === s.dealerSeat;
    const windIdx = (seatNum - s.dealerSeat + n) % n;

    // ユーザー名タグ(画面四隅固定)
    tagEl.className = 'player-tag corner-' + divKey + (p.riichi ? ' riichi' : '');
    tagEl.innerHTML = `${isDealer ? '<span class="dealer-mark">親</span> ' : ''}${p.username}${p.connected ? '' : ' (切断)'}`;

    // コンパス(自風・点数・リー棒置き場のみ。ユーザー名は表示しない)
    if (compassEl) {
      compassEl.classList.toggle('dealer', isDealer);
      compassEl.innerHTML = `
        <div class="wind">${WIND_KANJI[windIdx]}</div>
        <div class="score">${p.score}</div>
        <div class="riichi-stick ${p.riichi ? 'active' : ''}"></div>
      `;
    }

    // 手牌
    const handEl = document.getElementById('hand-' + divKey);
    if (divKey === 'self') {
      const mainTiles = handOrder.map((kind, idx) => tileHtml(kind, kind === selectedTileId, true, false, idx));
      const drawnTileHtml = drawnKind ? tileHtml(drawnKind, drawnKind === selectedTileId && !handOrder.includes(selectedTileId), true, false, -1, true) : '';
      handEl.innerHTML = mainTiles.join('') + drawnTileHtml;
      attachHandHandlers(handEl);
    } else {
      handEl.innerHTML = Array.from({ length: p.handCount }).map(() => tileHtml(null, false, false, true)).join('');
    }

    // 川
    if (riverEl) {
      riverEl.innerHTML = p.discards.map((k) => tileHtml(k, false, false, true)).join('');
    }

    // 鳴き
    const meldEl = document.getElementById('meld-' + divKey);
    meldEl.innerHTML = p.melds.map((m) => `<div style="display:flex; gap:2px;">${m.tiles.map((k) => tileHtml(k, false, false)).join('')}</div>`).join('');
  }

  renderActionBar();
}

function tileHtml(kind, selected, selectable, small, idx, isDrawn) {
  const cls = ['tile'];
  if (small) cls.push('small');
  if (!kind) cls.push('back');
  if (selected) cls.push('selected');
  if (isDrawn) cls.push('drawn-tile');
  const dataAttrs = selectable ? `data-kind="${kind}" data-idx="${idx}" ${isDrawn ? 'data-drawn="1"' : ''} draggable="true"` : '';
  return `<div class="${cls.join(' ')}" ${dataAttrs}>${kind || ''}</div>`;
}

// 牌を1回クリックで選択、選択中の牌をもう一度クリックすると即打牌する。
// ドラッグ&ドロップで並び替えもできる(ツモ牌を含めて自由に並び替え可能。
// 並び替え後にツモ牌をどこかへ動かした場合は「ツモ牌の間隔」は解除される)。
function attachHandHandlers(handEl) {
  const tiles = [...handEl.querySelectorAll('.tile[data-kind]')];
  tiles.forEach((el) => {
    const kind = el.dataset.kind;
    const isDrawn = el.dataset.drawn === '1';

    el.onclick = () => {
      if (el.classList.contains('selected')) {
        selectedTileId = kind;
        doDiscard(isDrawn);
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
        // ツモ牌をhandOrderの中に組み込む(以後は通常の手牌として並び替え対象になる)
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

// サーバー通信を伴わない、手牌部分のみの再描画(並び替え直後の即時反映用)
function renderHandOnly() {
  if (!state) return;
  const handEl = document.getElementById('hand-self');
  handEl.innerHTML = handOrder.map((kind, idx) => tileHtml(kind, kind === selectedTileId, true, false, idx)).join('');
  attachHandHandlers(handEl);
}

// リーチ可能かどうかの簡易判定(門前・未リーチ・点数1000以上・残り牌4枚以上)
// ※ 本来はその牌を切った後に手牌がテンパイするかまで判定すべきだが、
//   クライアント側では簡略化した条件のみでボタンの表示可否を決めている。
function canDeclareRiichi() {
  if (!state || state.yourSeat === -1) return false;
  const me = state.players[state.yourSeat];
  if (!me) return false;
  if (me.riichi) return false;
  if (me.melds.length > 0) return false;
  if (me.score < 1000) return false;
  if (state.wallRemaining < 4) return false;
  return true;
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

function doDiscard() {
  if (!selectedTileId) return;
  // yourHand は kind の配列のみ持っているため、サーバー側は同名複数所持でも先頭一致で処理する
  ws.send(JSON.stringify({ type: 'discard', tileId: selectedTileId, riichi: riichiMode }));
  selectedTileId = null; riichiMode = false;
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

// ---------- 七セグ風デジタル数字描画 ----------
function digitHtml(ch) {
  const segs = SEVEN_SEG[ch] || '';
  const all = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  return `<div class="digit">${all.map((seg) => `<div class="seg seg-${seg} ${segs.includes(seg) ? 'on' : ''}"></div>`).join('')}</div>`;
}
function sevenSegNumber(n, minDigits) {
  const str = String(Math.max(0, n)).padStart(minDigits || 1, '0');
  return `<div class="digit-group">${[...str].map(digitHtml).join('')}</div>`;
}

init();
