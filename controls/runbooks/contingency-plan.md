# Contingency plan (NIST CP-2, CP-4, CP-9, CP-10)

> DRAFT for owner approval. Owner: Omar Huertas.

## Targets
| Metric | Target | How met |
|---|---|---|
| RPO (data loss) | 24 hours | Nightly D1 export to an R2 bucket (encrypted). **Status: implemented 2026-10-09** (bucket `albena-backups`, cron 03:17 UTC, weekly verification; see `worker/RUNBOOK-restore.md`). D1 Time Travel is a second recovery point. |
| RTO (time to restore service) | 4 hours | Worker rollback or redeploy from git; DNS fallback to GitHub Pages |

## Recovery procedures
### Bad deploy (code)
1. `cd worker && npx wrangler deployments list` to identify the last good version.
2. `npx wrangler rollback [version-id]` to restore it. Verify with `scripts/check-headers.sh https://albena.ai`.
3. Fix forward in a PR; production deploys require the `production` environment reviewer.

### Cloudflare Worker unavailable or compromised
1. Redeploy from a tagged known-good commit: `git checkout <tag> && cd worker && npm ci && npx wrangler deploy`.
2. If Cloudflare itself is down or the Worker cannot be trusted, use the DNS fallback below.

### DNS rollback to GitHub Pages
The repo still carries the static site (`CNAME`, `index.html`, `.nojekyll`) from the previous GitHub Pages hosting.
1. In the registrar/DNS provider, set `albena.ai` apex A records to GitHub Pages (185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153) and `www` CNAME to `kaoshotbeatz-ops.github.io`. If DNS is on Cloudflare, set these records to DNS only (grey cloud) so traffic bypasses the Worker.
2. Ensure Pages is enabled on the repo (Settings > Pages) with the root of `main` and custom domain `albena.ai`, "Enforce HTTPS" on.
3. Expected limits: no form handling, no D1, no API; show a static notice. Record an Obvera Change.
4. Reverse the records when the Worker is healthy. Confirm TTL (use <= 300 s during an incident).

### D1 data loss or corruption
1. Identify the last good time. Restore with Time Travel: `npx wrangler d1 time-travel restore albena --timestamp=<ISO time>` (take a bookmark of current state first: `wrangler d1 time-travel info albena`).
2. Or import the latest verified R2 export (once implemented): `wrangler d1 execute albena --remote --file=<export.sql>`.
3. Verify record counts and an application smoke test.

### Secrets or accounts compromised
Follow `incident-response.md`. Rotate `CLOUDFLARE_API_TOKEN`, `TURNSTILE_SECRET_KEY`; re-enter as Worker/Actions secrets.

## Testing (CP-4)
- Restore test at least annually and after any backup change: restore into a scratch D1 database, verify counts, record result and duration under `controls/evidence/`.
- Rollback drill each quarter: `wrangler rollback` on staging.
- Tabletop: `tabletop-2026Q4.md`.

## Dependencies and contacts
Cloudflare, GitHub, registrar: see `controls/vendor-register.md`. Component list: `controls/inventory.md`.
