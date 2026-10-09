CREATE TABLE IF NOT EXISTS hubs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'My Hub',
  public_key TEXT NOT NULL UNIQUE,
  edition TEXT NOT NULL CHECK (edition IN ('mac','nvidia')),
  profile TEXT NOT NULL,
  version TEXT NOT NULL,
  update_channel TEXT NOT NULL DEFAULT 'stable' CHECK (update_channel IN ('stable','beta')),
  remote_access INTEGER NOT NULL DEFAULT 0 CHECK (remote_access IN (0,1)),
  health_ok INTEGER,
  health_json TEXT,
  last_seen INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hubs_account ON hubs(account_id);

CREATE TABLE IF NOT EXISTS hub_pair_codes (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

-- replay cache: sha256(signature) per hub, kept until the skew window has passed
CREATE TABLE IF NOT EXISTS hub_nonces (
  hub_id TEXT NOT NULL,
  sig_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (hub_id, sig_hash)
);
CREATE INDEX IF NOT EXISTS idx_hub_nonces_exp ON hub_nonces(expires_at);

CREATE TABLE IF NOT EXISTS hub_rate (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  edition TEXT NOT NULL CHECK (edition IN ('mac','nvidia')),
  channel TEXT NOT NULL CHECK (channel IN ('stable','beta')),
  version TEXT NOT NULL,
  manifest_url TEXT NOT NULL,
  signature_url TEXT NOT NULL,
  signature TEXT,
  sig_scheme TEXT NOT NULL DEFAULT 'ssh-ed25519',
  sha256 TEXT NOT NULL,
  released_at INTEGER NOT NULL,
  UNIQUE (edition, channel, version)
);
