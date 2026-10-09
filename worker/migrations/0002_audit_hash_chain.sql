-- AU-9 / AU-10: tamper-evident audit log. Each row carries
--   hash = SHA-256(prev_hash || canonical_row_json)
-- Columns are NULL until the row is sealed (see src/auditchain.ts). Rows that
-- already exist are sealed, oldest first, by the first sealing pass after deploy.
ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;
ALTER TABLE audit_log ADD COLUMN hash TEXT;
CREATE INDEX idx_audit_hash_null ON audit_log(id) WHERE hash IS NULL;
