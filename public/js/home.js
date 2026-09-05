let me = null;

async function init() {
  const res = await fetch('/api/me');
  if (!res.ok) { location.replace('/login.html?redirect=' + encodeURIComponent('xiama/home')); return; }
  const data = await res.json();
  me = data.user;
  document.getElementById('profUsername').textContent = me.username;
  document.getElementById('profUserId').textContent = me.userId;
  connectLobby();
}

function connectLobby() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/lobby`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'onlineCount') document.getElementById('onlineCount').textContent = msg.count;
  };
  ws.onclose = () => setTimeout(connectLobby, 3000);
}

function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

document.getElementById('profileBtn').onclick = () => openModal('profileModal');
document.getElementById('createRoomBtn').onclick = () => openModal('createModal');
document.getElementById('joinRoomBtn').onclick = () => openModal('joinModal');
document.getElementById('friendBtn').onclick = async () => {
  openModal('friendModal');
  await loadFriendData();
};

async function loadFriendData() {
  const [listRes, reqRes] = await Promise.all([
    fetch('/api/friends/list'), fetch('/api/friends/requests'),
  ]);
  const list = (await listRes.json()).friends || [];
  const reqs = (await reqRes.json()).requests || [];

  document.getElementById('friendList').innerHTML = list.length
    ? list.map((f) => `<div>${f.username} (ID: ${f.userId})</div>`).join('')
    : '<div style="color:var(--text-sub);">フレンドはいません</div>';

  document.getElementById('friendRequests').innerHTML = reqs.length
    ? reqs.map((r) => `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
        <span>${r.username} (ID: ${r.userId})</span>
        <button class="btn" onclick="acceptRequest('${r.userId}')">承認</button>
      </div>`).join('')
    : '<div style="color:var(--text-sub);">申請はありません</div>';
}

async function acceptRequest(fromUserId) {
  await fetch('/api/friends/accept', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromUserId }),
  });
  await loadFriendData();
}

async function searchUser() {
  const q = document.getElementById('searchUserId').value.trim();
  const res = await fetch('/api/friends/search?userId=' + encodeURIComponent(q));
  const data = await res.json();
  const el = document.getElementById('searchResult');
  if (!data.user) { el.innerHTML = '<span style="color:var(--text-sub);">見つかりません</span>'; return; }
  el.innerHTML = `<div style="display:flex; justify-content:space-between; align-items:center;">
    <span>${data.user.username} (ID: ${data.user.userId})</span>
    <button class="btn" onclick="sendRequest('${data.user.userId}')">フレンド申請</button>
  </div>`;
}

async function sendRequest(toUserId) {
  const res = await fetch('/api/friends/request', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toUserId }),
  });
  if (res.ok) alert('フレンド申請を送りました');
}

async function joinRoom() {
  const code = document.getElementById('joinRoomNumber').value.trim();
  const errEl = document.getElementById('joinError');
  errEl.textContent = '';
  if (!/^\d{4}$/.test(code)) { errEl.textContent = '4ケタの数字を入力してください'; return; }
  const res = await fetch('/api/room/check/' + code);
  const status = await res.json();
  if (!status.exists) { errEl.textContent = 'その部屋番号は存在しません'; return; }
  location.href = '/xiama/room?code=' + code;
}

async function createRoom() {
  const rules = {
    playerCount: Number(document.getElementById('rulePlayerCount').value),
    length: document.getElementById('ruleLength').value,
    tileCountPerKind: Number(document.getElementById('ruleTileCount').value),
    timer: document.getElementById('ruleTimer').value,
  };
  const res = await fetch('/api/room/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules }),
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || '作成に失敗しました'); return; }
  location.href = '/xiama/room?code=' + data.roomNumber;
}

init();
