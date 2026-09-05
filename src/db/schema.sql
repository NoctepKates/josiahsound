-- ユーザー
CREATE TABLE IF NOT EXISTS users (
  user_id     TEXT PRIMARY KEY,      -- 表示用ID (例: 8桁数字) ユーザーが検索に使う
  username    TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- セッション（簡易ログイン用トークン）
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(user_id),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at  INTEGER NOT NULL
);

-- フレンド関係（成立済み、双方向なので2行入れる運用）
CREATE TABLE IF NOT EXISTS friends (
  user_id     TEXT NOT NULL,
  friend_id   TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, friend_id)
);

-- フレンド申請（申請中のみ。承認されたらfriendsへ2行追加してここから削除）
CREATE TABLE IF NOT EXISTS friend_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id TEXT NOT NULL,
  to_user_id   TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(from_user_id, to_user_id)
);

-- 単語辞書（ひらがじゃんの役登録テーブル）
-- word: 濁音・半濁音・拗音・長音を含む表記そのまま（例: "ありがとう"）
-- han: この単語が確定したときの飜数
-- note: 任意メモ
CREATE TABLE IF NOT EXISTS words (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  word        TEXT NOT NULL UNIQUE,
  han         INTEGER NOT NULL DEFAULT 1,
  note        TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_words_word ON words(word);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
