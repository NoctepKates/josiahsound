function getRedirectParam() {
  return new URLSearchParams(location.search).get('redirect') || '';
}
function withRedirect(path) {
  const r = getRedirectParam();
  return r ? `${path}?redirect=${encodeURIComponent(r)}` : path;
}
function showError(msg) {
  const box = document.getElementById('errorBox');
  box.textContent = msg;
  box.style.display = 'block';
}

// ---------- ログインページ ----------
const loginBtn = document.getElementById('loginBtn');
if (loginBtn) {
  const toRegister = document.getElementById('toRegister');
  if (toRegister) toRegister.href = withRedirect('/register.html');

  loginBtn.onclick = async () => {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const remember = document.getElementById('remember').checked;
    if (!username || !password) { showError('ユーザー名とパスワードを入力してください'); return; }

    loginBtn.disabled = true;
    try {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, remember }),
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error || 'ログインに失敗しました'); return; }

      const redirect = getRedirectParam();
      location.replace(redirect ? `/${redirect}` : '/index.html');
    } finally {
      loginBtn.disabled = false;
    }
  };
}

// ---------- 登録ページ ----------
const registerBtn = document.getElementById('registerBtn');
if (registerBtn) {
  const toLogin = document.getElementById('toLogin');
  if (toLogin) toLogin.href = withRedirect('/login.html');

  registerBtn.onclick = async () => {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirmPassword').value;

    if (!username || !password || !confirmPassword) { showError('すべての項目を入力してください'); return; }
    if (password.length < 8) { showError('パスワードは8文字以上で入力してください'); return; }
    if (password !== confirmPassword) { showError('パスワードが一致しません'); return; }

    registerBtn.disabled = true;
    try {
      const res = await fetch('/api/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, confirmPassword }),
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error || '登録に失敗しました'); return; }

      location.href = withRedirect('/login.html');
    } finally {
      registerBtn.disabled = false;
    }
  };
}
