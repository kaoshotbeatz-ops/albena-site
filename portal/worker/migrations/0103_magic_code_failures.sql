-- Failed email-code attempts per address (HMAC of the email, never plaintext). After 10 in 24h the code path is locked; the link still works.
CREATE TABLE magic_code_failures (
  email_hash TEXT NOT NULL,
  failed_at INTEGER NOT NULL
);
CREATE INDEX idx_magic_code_failures ON magic_code_failures(email_hash, failed_at);
