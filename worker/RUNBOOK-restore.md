# Restore runbook (CP-4 / CP-9 / CP-10)

Backups: R2 bucket `albena-backups`, keys `backups/YYYY-MM-DD/{waitlist,tickets,audit_log}.ndjson.gz` + `manifest.json`
(staging: same under `staging/`). Daily 03:17 UTC, newest 35 kept. The Sunday run automatically re-reads the newest
manifest, checks SHA-256 + row counts + the audit hash chain and logs `backup.verified` / `backup.verify_failed`.
Public health: `GET /api/status`. Admin detail: `GET /api/admin/integrity` (Access).

## Full restore drill (manual, do at least quarterly; scratch DB only)
1. `npx wrangler d1 create albena-scratch` (never restore over production without an incident decision).
2. `npx wrangler d1 migrations apply albena-scratch --remote` (applies 0001 + 0002).
3. Pick a date D. Download: `npx wrangler r2 object get albena-backups/backups/D/waitlist.ndjson.gz --file waitlist.ndjson.gz` (same for tickets, audit_log, manifest.json).
4. Verify: `shasum -a 256 *.ndjson.gz` must equal the `sha256` values in `manifest.json`; `gunzip -c X.ndjson.gz | wc -l` must equal `rows`.
5. Convert NDJSON to SQL inserts and load (generated column `tickets.ticket_id` must be omitted):
   `gunzip -c waitlist.ndjson.gz | jq -r '"INSERT INTO waitlist (id,email,email_key,name,interest,ip_hash,created_at) VALUES (\(.id),\(.email|@json),\(.email_key|@json),\(.name|@json),\(.interest|@json),\(.ip_hash|@json),\(.created_at|@json));"' > waitlist.sql`
   Equivalent for tickets (`id,name,email,topic,message,status,ip_hash,created_at,updated_at`) and audit_log
   (`id,ts,actor,action,target,request_id,ip_hash,prev_hash,hash`). SQL-quote with `jq @json` only for plain strings; review before load.
   `npx wrangler d1 execute albena-scratch --remote --file waitlist.sql` (etc.)
6. Check the restored audit chain: the last row's `hash` must equal `manifest.auditHead`; recompute with the same algorithm as `verifyChain` in `src/auditchain.ts` (SHA-256 of prev_hash + JSON `[id,ts,actor,action,target,request_id,ip_hash]`).
7. Record the drill: add an audit/WORKLOG entry; delete the scratch DB (`npx wrangler d1 delete albena-scratch`).

## Notes
- Audit chain: rows are inserted unsealed then sealed in JS (D1 has no SHA-256). Existing rows are sealed on first run
  after migration 0002 (trust-on-first-seal: history before that date is not provably untampered).
- Retention (SI-12): daily cron anonymizes (name/email/message/ip_hash) tickets in `closed`/`resolved` untouched for
  365 days and logs `retention.tickets_anonymized count:N`. Waitlist is kept until launch, then delete or re-consent.
  Backups contain PII until they age out after 35 days; anonymized tickets reappear redacted in later backups.
