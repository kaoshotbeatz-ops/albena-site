-- Portal security page: owner commands for a Hub (heartbeat reply) and the sign-in method of a session.
-- sessions.login_method is set at login ('passkey' | 'magic'); NULL (sessions older than this migration, view-as) is NOT a passkey session.
ALTER TABLE sessions ADD COLUMN login_method TEXT;

CREATE TABLE hub_security_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hub_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('chain_ack', 'revoke_trust')),
  sig TEXT,
  requested_by TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  delivered_at INTEGER,
  dropped INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE INDEX hub_security_commands_pending ON hub_security_commands(hub_id, delivered_at);
