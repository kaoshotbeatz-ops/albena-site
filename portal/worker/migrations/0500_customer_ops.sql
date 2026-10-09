-- Customer lifecycle (staff-run): manual entitlements, invites, notes, manual orders, reserved hubs, license keys, household invites.
-- Entitlement precedence: a row with source='manual' is only replaced by Stripe when a Stripe subscription becomes active/trialing.

ALTER TABLE users ADD COLUMN name TEXT;

ALTER TABLE entitlements ADD COLUMN source TEXT NOT NULL DEFAULT 'stripe';   -- stripe | manual
ALTER TABLE entitlements ADD COLUMN ends_at INTEGER;                          -- manual grants only; NULL = no expiry
ALTER TABLE entitlements ADD COLUMN note TEXT;                                -- staff-only
ALTER TABLE entitlements ADD COLUMN max_hubs INTEGER;                         -- manual override of the plan's hub allowance
ALTER TABLE entitlements ADD COLUMN comp INTEGER NOT NULL DEFAULT 0;          -- 1 = complimentary (plan column holds the plan it mirrors)

CREATE TABLE entitlement_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,              -- support:<email> | system:cron | system:stripe | invite
  kind TEXT NOT NULL,               -- grant | extend | suspend | reactivate | expired | archived_by_stripe
  source TEXT NOT NULL,
  plan TEXT,
  status TEXT,
  ends_at INTEGER,
  note TEXT
);
CREATE INDEX idx_entitlement_history_account ON entitlement_history(account_id, id);

-- Staff-only notes, append-only while the account exists (they go with the account on deletion).
CREATE TABLE account_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX idx_account_notes_account ON account_notes(account_id, id);
CREATE TRIGGER account_notes_no_update BEFORE UPDATE ON account_notes BEGIN SELECT RAISE(ABORT, 'notes_append_only'); END;
CREATE TRIGGER account_notes_no_delete BEFORE DELETE ON account_notes
WHEN EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id)
BEGIN SELECT RAISE(ABORT, 'notes_append_only'); END;

-- Customer invites: single-use hashed token.
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  token_hash TEXT NOT NULL,
  plan TEXT,                        -- optional entitlement created on acceptance (a manual-grant plan)
  base_plan TEXT,                   -- for plan='comp'
  days INTEGER,                     -- grant length for pilot / comp
  note TEXT,
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  revoked_at INTEGER,
  account_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  send_count INTEGER NOT NULL DEFAULT 1,
  last_sent_at INTEGER NOT NULL
);
CREATE INDEX idx_invites_email ON invites(email);

-- Manual hardware orders live next to Stripe ones.
ALTER TABLE hardware_orders ADD COLUMN source TEXT NOT NULL DEFAULT 'stripe';  -- stripe | manual
ALTER TABLE hardware_orders ADD COLUMN edition TEXT;
ALTER TABLE hardware_orders ADD COLUMN staff_notes TEXT;
ALTER TABLE hardware_orders ADD COLUMN carrier TEXT;
ALTER TABLE hardware_orders ADD COLUMN tracking TEXT;
ALTER TABLE hardware_orders ADD COLUMN shipped_at INTEGER;
ALTER TABLE hardware_orders ADD COLUMN delivered_at INTEGER;
ALTER TABLE hardware_orders ADD COLUMN updated_at INTEGER;
ALTER TABLE hardware_orders ADD COLUMN created_by TEXT;

-- Pre-provisioned Hub: binds to the account when the Hub presents its serial and proves its Ed25519 key. Single use.
CREATE TABLE reserved_hubs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  serial TEXT NOT NULL UNIQUE,
  edition TEXT NOT NULL CHECK (edition IN ('mac','nvidia')),
  name TEXT,
  public_key TEXT,                  -- optional: when staff know the Hub's key, only that key can bind
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  hub_id TEXT
);
CREATE INDEX idx_reserved_hubs_account ON reserved_hubs(account_id);

-- BYO license keys: shown once, stored as a peppered SHA-256. Reusable while the account has a free Hub slot.
CREATE TABLE license_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,               -- last 4 characters
  label TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_license_keys_account ON license_keys(account_id);

-- Household invites: the owner invites an email; signing in with it joins the account as a member.
CREATE TABLE member_invites (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX idx_member_invites_email ON member_invites(email);
CREATE INDEX idx_member_invites_account ON member_invites(account_id);
