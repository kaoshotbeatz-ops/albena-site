-- Email sign-in code: second way to redeem a magic token from the requesting browser.
-- code_hash is NULL for tokens issued before this migration (link-only).
ALTER TABLE magic_tokens ADD COLUMN code_hash TEXT;
ALTER TABLE magic_tokens ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
