let me = null;

async function init() {
  const res = await fetch('/api/me');
  if (!res.ok) { location.replace('/login.html?redirect=' + encodeURIComponent('xiama/home')); return; }
  const data = await res.json();
  me = data.user;
  document.getElementById('profUsername').textContent = me.username;
  document.getElementById('profUserId').textContent = me.userId;
  showAvatar(me.avatarUrl);
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

// ---------- ログアウト ----------
async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } finally {
    // セッションCookieはサーバーが消す。ログイン画面へ戻る。
    location.replace('/login.html');
  }
}

document.getElementById('logoutBtn').onclick = logout;
document.getElementById('logoutBtn2').onclick = logout;

// ---------- プロフィール画像 ----------
const AVATAR_SIZE = 128; // 保存する画像の一辺(px)。小さく切り出して保存する

// 画像が無いときは、ユーザー名の頭文字の丸を絵として作って表示する
function initialAvatarDataUrl() {
  const c = document.createElement('canvas');
  c.width = c.height = AVATAR_SIZE;
  const g = c.getContext('2d');
  g.fillStyle = '#20283a';
  g.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
  g.fillStyle = '#e8d9b0';
  g.font = 'bold 64px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(Array.from(me?.username || '?')[0] || '?', AVATAR_SIZE / 2, AVATAR_SIZE / 2 + 4);
  return c.toDataURL('image/png');
}

function showAvatar(url) {
  document.getElementById('profAvatar').src = url || initialAvatarDataUrl();
}

// 選んだ画像を、中央で正方形に切り出して AVATAR_SIZE x AVATAR_SIZE に縮小し、data URLにする
function resizeToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;

      const c = document.createElement('canvas');
      c.width = c.height = AVATAR_SIZE;
      c.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

      // WebPに対応していないブラウザでは、PNGが返ってくる(どちらもサーバーで受け付ける)
      let dataUrl = c.toDataURL('image/webp', 0.85);
      if (!dataUrl.startsWith('data:image/webp')) dataUrl = c.toDataURL('image/png');

      resolve(dataUrl);
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('画像を読み込めませんでした'));
    };

    img.src = objectUrl;
  });
}

async function saveAvatar(avatar) {
  const msg = document.getElementById('avatarMsg');
  msg.textContent = '保存中...';

  const res = await fetch('/api/profile/avatar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatar }),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    msg.textContent = data.error || '保存に失敗しました';
    return;
  }

  me.avatarUrl = data.avatarUrl;
  showAvatar(me.avatarUrl);
  msg.textContent = avatar ? 'プロフィール画像を設定しました' : 'プロフィール画像を削除しました';
}

document.getElementById('avatarPickBtn').onclick = () =>
  document.getElementById('avatarFile').click();

document.getElementById('avatarFile').onchange = async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = ''; // 同じ画像をもう一度選べるようにする
  if (!file) return;

  const msg = document.getElementById('avatarMsg');
  try {
    await saveAvatar(await resizeToDataUrl(file));
  } catch (e) {
    msg.textContent = e.message || '画像を設定できませんでした';
  }
};

document.getElementById('avatarRemoveBtn').onclick = () => saveAvatar(null);
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
