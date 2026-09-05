import bcrypt from 'bcryptjs';

import { GameRoom } from './GameRoom';
import { Lobby } from './Lobby';

export { GameRoom, Lobby };

export interface Env {
  DB: D1Database;
  GAME_ROOM: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  ASSETS: Fetcher;
}

function randomId(len: number, digitsOnly = true): string {
  const chars = digitsOnly ? '0123456789' : 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('Cookie') || '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

async function getSession(request: Request, env: Env): Promise<{ userId: string; username: string } | null> {
  const cookies = parseCookies(request);
  const token = cookies['session'];
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.user_id as userId, u.username as username FROM sessions s
     JOIN users u ON u.user_id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`
  ).bind(token, Math.floor(Date.now() / 1000)).first<{ userId: string; username: string }>();
  return row || null;
}

function json(data: any, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(init.headers || {}) },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ---------- 認証 ----------
      if (path === '/api/register' && request.method === 'POST') {
        const { username, password, confirmPassword } = await request.json() as {
          username: string; password: string; confirmPassword: string;
        };
        if (!username?.trim() || !password || !confirmPassword) {
          return json({ error: 'すべての項目を入力してください' }, { status: 400 });
        }
        if (password.length < 8) {
          return json({ error: 'パスワードは8文字以上で入力してください' }, { status: 400 });
        }
        if (password !== confirmPassword) {
          return json({ error: 'パスワードが一致しません' }, { status: 400 });
        }
        const existing = await env.DB.prepare('SELECT user_id FROM users WHERE username = ?')
          .bind(username).first();
        if (existing) {
          return json({ error: 'そのユーザー名は既に使用されています' }, { status: 409 });
        }
        const passwordHash = await bcrypt.hash(password, 10);
        let userId = '';
        for (let attempt = 0; attempt < 10; attempt++) {
          const candidate = randomId(8);
          const dup = await env.DB.prepare('SELECT user_id FROM users WHERE user_id = ?').bind(candidate).first();
          if (!dup) { userId = candidate; break; }
        }
        if (!userId) return json({ error: 'ユーザーIDの発行に失敗しました' }, { status: 500 });

        try {
          await env.DB.prepare('INSERT INTO users (user_id, username, password_hash) VALUES (?, ?, ?)')
            .bind(userId, username, passwordHash).run();
        } catch {
          return json({ error: 'そのユーザー名は既に使用されています' }, { status: 409 });
        }
        return json({ ok: true, userId });
      }

      if (path === '/api/login' && request.method === 'POST') {
        const { username, password, remember } = await request.json() as {
          username: string; password: string; remember?: boolean;
        };
        if (!username || !password) return json({ error: 'ユーザー名とパスワードを入力してください' }, { status: 400 });

        const user = await env.DB.prepare(
          'SELECT user_id as userId, username, password_hash as passwordHash FROM users WHERE username = ?'
        ).bind(username).first<{ userId: string; username: string; passwordHash: string }>();

        if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
          return json({ error: 'ユーザー名またはパスワードが違います' }, { status: 401 });
        }

        const token = randomId(32, false);
        const remembered = !!remember;
        const ttlSeconds = remembered ? 60 * 60 * 24 * 30 : 60 * 60 * 24; // remember: 30日 / 通常: 1日
        const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
        await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
          .bind(token, user.userId, expires).run();

        // remember meがOFFの場合はMax-Ageを付けずブラウザを閉じたら消えるセッションCookieにする
        const cookieParts = [`session=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
        if (remembered) cookieParts.push(`Max-Age=${ttlSeconds}`);

        return json({ ok: true, user: { userId: user.userId, username: user.username } }, {
          headers: { 'Set-Cookie': cookieParts.join('; ') },
        });
      }

      if (path === '/api/logout' && request.method === 'POST') {
        const cookies = parseCookies(request);
        if (cookies['session']) {
          await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(cookies['session']).run();
        }
        return json({ ok: true }, { headers: { 'Set-Cookie': 'session=; Path=/; HttpOnly; Max-Age=0' } });
      }

      if (path === '/api/me') {
        const session = await getSession(request, env);
        if (!session) return json({ error: 'unauthorized' }, { status: 401 });
        return json({ user: session });
      }

      // ---------- フレンド ----------
      if (path === '/api/friends/list') {
        const session = await getSession(request, env);
        if (!session) return json({ error: 'unauthorized' }, { status: 401 });
        const res = await env.DB.prepare(
          `SELECT u.user_id as userId, u.username as username FROM friends f
           JOIN users u ON u.user_id = f.friend_id WHERE f.user_id = ?`
        ).bind(session.userId).all();
        return json({ friends: res.results || [] });
      }

      if (path === '/api/friends/requests') {
        const session = await getSession(request, env);
        if (!session) return json({ error: 'unauthorized' }, { status: 401 });
        const res = await env.DB.prepare(
          `SELECT fr.id, u.user_id as userId, u.username as username FROM friend_requests fr
           JOIN users u ON u.user_id = fr.from_user_id WHERE fr.to_user_id = ?`
        ).bind(session.userId).all();
        return json({ requests: res.results || [] });
      }

      if (path === '/api/friends/search') {
        const session = await getSession(request, env);
        if (!session) return json({ error: 'unauthorized' }, { status: 401 });
        const q = url.searchParams.get('userId') || '';
        const user = await env.DB.prepare('SELECT user_id as userId, username FROM users WHERE user_id = ?')
          .bind(q).first();
        return json({ user: user || null });
      }

      if (path === '/api/friends/request' && request.method === 'POST') {
        const session = await getSession(request, env);
        if (!session) return json({ error: 'unauthorized' }, { status: 401 });
        const { toUserId } = await request.json() as { toUserId: string };
        if (toUserId === session.userId) return json({ error: 'cannot friend yourself' }, { status: 400 });
        await env.DB.prepare('INSERT OR IGNORE INTO friend_requests (from_user_id, to_user_id) VALUES (?, ?)')
          .bind(session.userId, toUserId).run();
        return json({ ok: true });
      }

      if (path === '/api/friends/accept' && request.method === 'POST') {
        const session = await getSession(request, env);
        if (!session) return json({ error: 'unauthorized' }, { status: 401 });
        const { fromUserId } = await request.json() as { fromUserId: string };
        await env.DB.batch([
          env.DB.prepare('DELETE FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?').bind(fromUserId, session.userId),
          env.DB.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)').bind(session.userId, fromUserId),
          env.DB.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)').bind(fromUserId, session.userId),
        ]);
        return json({ ok: true });
      }

      // ---------- 部屋 ----------
      if (path === '/api/room/create' && request.method === 'POST') {
        const session = await getSession(request, env);
        if (!session) return json({ error: 'unauthorized' }, { status: 401 });
        const { rules } = await request.json() as { rules: any };

        let roomNumber = '';
        for (let attempt = 0; attempt < 20; attempt++) {
          const candidate = randomId(4);
          if (candidate === '0000') continue;
          const id = env.GAME_ROOM.idFromName(candidate);
          const stub = env.GAME_ROOM.get(id);
          const statusRes = await stub.fetch('https://do/status');
          const status = await statusRes.json() as any;
          if (!status.exists) { roomNumber = candidate; break; }
        }
        if (!roomNumber) return json({ error: '空いている部屋番号が見つかりませんでした' }, { status: 500 });

        const id = env.GAME_ROOM.idFromName(roomNumber);
        const stub = env.GAME_ROOM.get(id);
        await stub.fetch('https://do/init', {
          method: 'POST',
          body: JSON.stringify({ roomNumber, hostUserId: session.userId, rules }),
        });
        return json({ ok: true, roomNumber });
      }

      if (path.startsWith('/api/room/check/')) {
        const code = path.split('/').pop() || '';
        const id = env.GAME_ROOM.idFromName(code);
        const stub = env.GAME_ROOM.get(id);
        const statusRes = await stub.fetch('https://do/status');
        const status = await statusRes.json() as any;
        return json(status);
      }

      // ---------- WebSocket ----------
      if (path === '/ws/lobby') {
        const id = env.LOBBY.idFromName('lobby-singleton');
        const stub = env.LOBBY.get(id);
        return stub.fetch('https://do/ws', request as any);
      }

      if (path.startsWith('/ws/room/')) {
        const session = await getSession(request, env);
        const code = path.split('/').pop() || '';
        const id = env.GAME_ROOM.idFromName(code);
        const stub = env.GAME_ROOM.get(id);
        const wsUrl = new URL('https://do/ws');
        wsUrl.searchParams.set('userId', session?.userId || `guest_${randomId(6)}`);
        wsUrl.searchParams.set('username', session?.username || 'ゲスト');
        return stub.fetch(wsUrl.toString(), request as any);
      }

      // ---------- 静的ファイル ----------
      return env.ASSETS.fetch(request);
    } catch (err: any) {
      return json({ error: String(err?.message || err) }, { status: 500 });
    }
  },
};
