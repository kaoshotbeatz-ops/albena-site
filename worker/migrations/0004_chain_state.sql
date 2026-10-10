-- ALB-SEC-1: result of the daily audit-chain verifier and the R3 hold it controls.
-- One row. A break sets status='broken' + broken_sig; high-risk routes refuse (HTTP 423)
-- while status='broken' and acked_sig differs from broken_sig. Acknowledging writes an
-- audit_log row (audit.chain.ack) and sets acked_sig; it never touches audit_log history.
CREATE TABLE chain_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'unknown',
  broken_sig TEXT,
  broken_reason TEXT,
  broken_at_id INTEGER,
  detected_at TEXT,
  acked_sig TEXT,
  acked_by TEXT,
  acked_at TEXT,
  ack_note TEXT,
  last_run_at TEXT,
  last_ok_at TEXT,
  last_head TEXT,
  last_rows INTEGER,
  last_alert TEXT
);
INSERT INTO chain_state (id) VALUES (1);
