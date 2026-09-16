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

let handOrder = [ { id, king } ];

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
    } else if (msg.type === 'result') {
      showResult(msg);
    } else if (msg.type === 'matchEnd') {
      showMatchEnd(msg);
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

function reconcileHandOrder(newTiles) {
  const remaining = [...newTiles];
  const kept = [];

  for (const oldTile of handOrder) {
    const idx = remaining.findIndex((t) => t.id === oldTile.id);

    if (idx !== -1) {
      kept.push(remaining[idx]);
      remaining.splice(idx, 1);
    }
  }

  remaining.sort((a, b) => a.kind.localeCompare(b.kind));
  handOrder = [...kept, ...remaining];
}

function render(s) {
  state = s;
  canTsumoNow = false;

  const n = s.rules.playerCount;
  const my = s.yourSeat;

  document.getElementById('roundInfo').textContent =
    `第${s.round}局 (${s.honba}本場)`;

  renderDeadWall(s);

  const wallDigits = document.getElementById('wallDigits');

  if (wallDigits) {
    wallDigits.innerHTML =
      sevenSegNumber(s.wallRemaining, 2);
  }

  renderDevBar(s);

  let drawnTile = null;

  if (my !== -1) {
    const hand = [...s.yourHand];

    if (s.yourDrawnTile) {
      const idx = hand.findIndex(
        (t) => t.id === s.yourDrawnTile.id
      );

      if (idx !== -1) {
        drawnTile = hand.splice(idx, 1)[0];
      }
    }

    reconcileHandOrder(hand);
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

    const activeIdx =
      activeDivKeys.indexOf(divKey);

    if (activeIdx === -1) {
      [seatEl, riverEl, compassEl, tagEl].forEach((el) => {
        if (el) el.style.display = 'none';
      });

      continue;
    }

    if (seatEl) seatEl.style.display = 'flex';
    if (riverEl) riverEl.style.display = 'flex';
    if (compassEl) compassEl.style.display = 'flex';
    if (tagEl) tagEl.style.display = 'flex';

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
        `${isDealer ? '<span class="dealer-mark">親</span> ' : ''}` +
        `${p.username}${p.connected ? '' : ' (切断)'}`;
    }

    if (compassEl) {
      compassEl.classList.toggle(
        'dealer',
        isDealer
      );

      compassEl.innerHTML = `
        <div class="wind">${WIND_KANJI[windIdx]}</div>
        <div class="score">${p.score}</div>
        <div class="riichi-stick ${p.riichi ? 'active' : ''}"></div>
      `;
    }

    const handEl =
      document.getElementById('hand-' + divKey);

    if (!handEl) continue;

    if (divKey === 'self') {
      const mainTiles = handOrder.map(
        (kind, idx) =>
          tileHtml(
            kind,
            kind === selectedTileId,
            true,
            false,
            idx
          )
      );

      const mainTiles = handOrder.map((tile, idx) =>
        tileHtml(
          tile.kind,
          tile.id === selectedTileId,
          true,
          false,
          idx
        )
      );

      const drawnTileHtml = drawnTile
        ? tileHtml(
            drawnTile.kind,
            drawnTile.id === selectedTileId,
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
  }

  renderActionBar();
  renderDevWall(s);
}

function tileHtml(kind, selected, selectable, small, idx, isDrawn, tileId) {
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

  return `<div class="${cls.join(' ')}" ${dataAttrs}>${kind || ''}</div>`;
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
  const tiles =
    [...handEl.querySelectorAll('.tile[data-kind]')];

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
      dragFromIdx =
        isDrawn
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
        moved =
          handOrder.splice(
            dragFromIdx,
            1
          )[0];
      }

      const insertAt =
        Math.min(
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

  const handEl = document.getElementById('hand-self');

  const mainTiles = handOrder.map((kind, idx) =>
    tileHtml(
      kind,
      kind === selectedTileId,
      true,
      false,
      idx
    )
  );

  let drawnTileHtml = '';

  // ツモ牌が手牌の並び替え対象にまだ入っていない場合だけ表示する
  if (
    state.yourDrawnTile &&
    !handOrder.includes(state.yourDrawnTile)
  ) {
    drawnTileHtml = tileHtml(
      state.yourDrawnTile,
      state.yourDrawnTile === selectedTileId,
      true,
      false,
      -1,
      true
    );
  }

  handEl.innerHTML = mainTiles.join('') + drawnTileHtml;

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

  return (
    Array.isArray(state.riichiDiscards) &&
    state.riichiDiscards.length > 0
  );
}

function doDiscard() {
  if (!selectedTileId) return;

  if (!state) return;

  if (riichiMode) {
    const legal =
      Array.isArray(state.riichiDiscards) &&
      state.riichiDiscards.includes(
        selectedTileId
      );

    if (!legal) {
      alert(
        'その牌を切ってもテンパイにならないため、リーチできません。'
      );
      return;
    }
  }

  /*
   * 開発者モードでは1つのWebSocketで複数席を操作するため、
   * 必ず現在表示している席番号を送る。
   */
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
}

function renderActionBar() {
  const bar =
    document.getElementById('actionBar');

  if (!bar) return;

  bar.innerHTML = '';

  if (!state || state.yourSeat === -1) {
    return;
  }

  const isMyTurn =
    state.currentTurnSeat ===
    state.yourSeat;

  if (!isMyTurn) return;

  if (canDeclareRiichi()) {
    const riichiBtn =
      document.createElement('button');

    riichiBtn.className =
      'btn' +
      (riichiMode ? ' primary' : '');

    riichiBtn.textContent = 'リーチ';

    riichiBtn.onclick = () => {
      riichiMode = !riichiMode;
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
  const modal =
    document.getElementById(
      'callModal'
    );

  if (modal) {
    modal.classList.remove(
      'hidden'
    );
    modal.dataset.forSeat = forSeat !== undefined ? String(forSeat) : '';
  }

  const titleEl = document.querySelector('#callModal h3');
  if (titleEl) {
    const seatLabel = (state && state.devMode && forSeat !== undefined) ? `(席${forSeat + 1}) ` : '';
    titleEl.textContent = `${seatLabel}鳴きますか？`;
  }

  const container =
    document.getElementById(
      'callCandidates'
    );

  if (!container) return;

  container.innerHTML =
    candidates
      .map(
        (c) => `
          <button
            class="btn primary"
            onclick="respondCall(true, '${c.word}', ${forSeat})"
          >
            ${c.word}（${c.han}翻）で鳴く
          </button>
        `
      )
      .join('');
}

function respondCall(
  accept,
  word,
  forSeat
) {
  const modal =
    document.getElementById(
      'callModal'
    );
  const seat = forSeat !== undefined
    ? forSeat
    : (modal && modal.dataset.forSeat ? Number(modal.dataset.forSeat) : state.yourSeat);

  ws.send(
    JSON.stringify({
      type: 'callDecision',
      accept,
      word,
      seat,
    })
  );

  if (modal) {
    modal.classList.add(
      'hidden'
    );
  }

  dequeueAndShowNext();
}

function showResult(msg) {
  const card =
    document.getElementById(
      'resultCard'
    );

  if (msg.kind === 'draw') {
    card.innerHTML =
      `<h2>流局</h2><p>${
        msg.reason === 'four-riichi'
          ? '四家立直'
          : '牌切れ'
      }</p>`;
  } else if (
    msg.kind === 'tsumo'
  ) {
    card.innerHTML =
      renderWinCard(
        'ツモ',
        [
          {
            decomp: msg.decomp,
            score: msg.score,
            winner: msg.winner,
          },
        ],
        state
      );
  } else {
    card.innerHTML =
      renderWinCard(
        'ロン',
        msg.results,
        state
      );
  }

  document
    .getElementById(
      'resultOverlay'
    )
    .classList.remove(
      'hidden'
    );

  setTimeout(
    () =>
      document
        .getElementById(
          'resultOverlay'
        )
        .classList.add(
          'hidden'
        ),
    6000
  );
}

function renderWinCard(
  title,
  results,
  s
) {
  return (
    `<h2>${title}</h2>` +
    results
      .map((r) => {
        const winnerName =
          s.players[r.winner]
            ?.username || '';

        return `
          <div
            style="
              margin-bottom:16px;
              border-bottom:1px solid var(--border);
              padding-bottom:12px;
            "
          >
            <div>${winnerName} の和了</div>

            <div class="word-list">
              ${r.decomp.words
                .map(
                  (w) =>
                    `<span class="word-chip">${w}</span>`
                )
                .join('')}
            </div>

            <div class="han-fu">
              ${r.score.han}翻
              ${r.score.fu}符${
                r.score.limitName
                  ? ' (' +
                    r.score.limitName +
                    ')'
                  : ''
              }
            </div>

            <div>
              ${r.score.payments.total}点
            </div>
          </div>
        `;
      })
      .join('')
  );
}

function showMatchEnd(msg) {
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
    `<h2>対局終了</h2>` +
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
    'calc(6 * (var(--tile-w) + var(--tile-gap)))';

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