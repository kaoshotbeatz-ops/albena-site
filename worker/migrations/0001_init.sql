-- Albena site schema. PII is limited to email + name (+ support message body).
-- IPs are never stored raw: ip_hash = SHA-256(IP_SALT:ip).

CREATE TABLE waitlist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,            -- trimmed + lowercased
  email_key  TEXT NOT NULL UNIQUE,     -- dedupe key (gmail dots / +tags folded)
  name       TEXT,
  interest   TEXT,
  ip_hash    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_waitlist_created ON waitlist(created_at);

CREATE TABLE tickets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  TEXT GENERATED ALWAYS AS ('ALB-' || printf('%06d', id)) STORED,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  topic      TEXT NOT NULL,
  message    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open'
             CHECK (status IN ('open','in_progress','resolved','closed')),
  ip_hash    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_tickets_status_created ON tickets(status, created_at);
CREATE INDEX idx_tickets_email ON tickets(email);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor      TEXT NOT NULL,            -- 'public' or Access identity (email/sub)
  action     TEXT NOT NULL,
  target     TEXT,                     -- e.g. waitlist:12, ticket:ALB-000123
  request_id TEXT NOT NULL,
  ip_hash    TEXT
);
CREATE INDEX idx_audit_ts ON audit_log(ts);
CREATE INDEX idx_audit_actor ON audit_log(actor, ts);
CREATE INDEX idx_audit_action ON audit_log(action, ts);
