PRAGMA foreign_keys = ON;
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE members (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK(role IN ('owner', 'member')),
  PRIMARY KEY (account_id, user_id)
);
CREATE TABLE magic_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX magic_tokens_expiry ON magic_tokens(expires_at);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL CHECK(counter >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('register', 'login')),
  user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  session_id TEXT,
  browser_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_challenges_expiry ON auth_challenges(expires_at);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  request_id TEXT NOT NULL,
  ip_hash TEXT,
  meta TEXT,
  prev_hash TEXT,
  hash TEXT
);
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_delete_guard'); END;
CREATE TRIGGER audit_no_rewrite BEFORE UPDATE ON audit_log
WHEN OLD.hash IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.ts IS NOT OLD.ts OR NEW.actor IS NOT OLD.actor
 OR NEW.action IS NOT OLD.action OR NEW.target IS NOT OLD.target OR NEW.request_id IS NOT OLD.request_id
 OR NEW.ip_hash IS NOT OLD.ip_hash OR NEW.meta IS NOT OLD.meta
BEGIN SELECT RAISE(ABORT, 'audit_write_guard'); END;
