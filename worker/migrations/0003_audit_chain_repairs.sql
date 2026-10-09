-- Record of audit chain repairs (re-seals after a concurrent-sealer fork). Keeps the
-- superseded hashes so the repair is itself auditable. Written by repairChain().
CREATE TABLE audit_chain_repairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repaired_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  actor TEXT NOT NULL,
  request_id TEXT NOT NULL,
  old_head TEXT,
  fork_head TEXT,
  old_hashes TEXT NOT NULL,
  repair_row_id INTEGER
);
