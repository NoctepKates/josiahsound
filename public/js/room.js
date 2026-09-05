const code = new URLSearchParams(location.search).get('code');
document.getElementById('roomNumber').textContent = code;
document.getElementById('inviteRoomNumber').textContent = code;

let me = null;
let ws = null;
let latestState = null;

const LENGTH_LABEL = { ichikyoku: '一局', tonpuu: '東風', hanchan: '半荘', honchan: '本荘' };
const TIMER_LABEL = { '5+20': '5秒+20秒', '5+300': '5秒+300秒', unlimited: '無制限' };

async function init() {
  if (!code || !/^\d{4}$/.test(code)) {
    alert('部屋番号が指定されていません。');
    location.replace('/xiama/home');
    return;
  }
  const res = await fetch('/api/me');
  if (!res.ok) { location.replace('/login.html?redirect=' + encodeURIComponent('xiama/room?code=' + code)); return; }

  const statusRes = await fetch('/api/room/check/' + code);
  const status = await statusRes.json();
  if (!status.exists) {
    alert('その部屋は存在しません。');
    location.replace('/xiama/home');
    return;
  }
  me = (await res.json()).user;
  connect();
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/room/${code}`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state') render(msg);
    if (msg.type === 'matchEnd') { /* 対局終了はxiama/table側で処理 */ }
  };
  ws.onclose = () => { /* 再接続はxiama/table優先のため簡易に留める */ };
}

function render(state) {
  latestState = state;
  if (state.phase === 'playing') {
    location.href = `/xiama/table?code=${code}`;
    return;
  }
  document.getElementById('rulesView').innerHTML = `
    人数: ${state.rules.playerCount}人麻雀<br>
    形式: ${LENGTH_LABEL[state.rules.length]}<br>
    各文字の枚数: ${state.rules.tileCountPerKind}枚<br>
    持ち時間: ${TIMER_LABEL[state.rules.timer]}
  `;
  document.getElementById('playerCountLabel').textContent = `(${state.players.length}/${state.rules.playerCount})`;
  document.getElementById('playerList').innerHTML = state.players.map((p) => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:var(--bg-panel-2); border-radius:8px;">
      <span>${p.username} ${p.userId === state.hostUserId ? '<span style="color:var(--gold-bright); font-size:12px;">(ホスト)</span>' : ''}</span>
      <span style="color:${p.ready ? '#4caf50' : 'var(--text-sub)'};">${p.ready ? '準備OK' : '未準備'}</span>
    </div>
  `).join('');

  const readyBtn = document.getElementById('readyBtn');
  const meInfo = state.players[state.yourSeat];
  readyBtn.textContent = meInfo && meInfo.ready ? '準備解除' : '準備OK';
}

document.getElementById('readyBtn').onclick = () => {
  const meInfo = latestState && latestState.players[latestState.yourSeat];
  ws.send(JSON.stringify({ type: 'ready', ready: !(meInfo && meInfo.ready) }));
};

document.getElementById('inviteBtn').onclick = async () => {
  document.getElementById('inviteModal').classList.remove('hidden');
  const res = await fetch('/api/friends/list');
  const friends = (await res.json()).friends || [];
  document.getElementById('inviteFriendList').innerHTML = friends.length
    ? friends.map((f) => `<div style="display:flex; justify-content:space-between; padding:6px 0;">
        <span>${f.username}</span>
        <button class="btn" onclick="alert('${f.username} に部屋番号 ${code} を伝えました(通知機能は未実装のため今後追加予定)')">招待</button>
      </div>`).join('')
    : '<div style="color:var(--text-sub);">フレンドがいません</div>';
};

init();
