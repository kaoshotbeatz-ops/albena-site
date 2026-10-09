# System component inventory (NIST CM-8, SR-4)

> DRAFT for owner review. Snapshot 2026-10-09. Update on any infrastructure change (record the Obvera Change id). Owner of all components: Omar Huertas, Omar Huertas LLC, unless stated.

| Component | Purpose | Owner | Data held / processed | Criticality | Notes |
|---|---|---|---|---|---|
| Cloudflare Worker `albena-site` (+ staging `albena-site-staging`) | Serves the site, API and form handling | Omar Huertas | Request metadata, submitted form fields in transit | High (site availability and integrity) | Config in `worker/wrangler.jsonc`; deploy via CI `wrangler deploy`; rollback via `wrangler rollback` |
| Cloudflare D1 database `albena` | Stores submissions/records | Omar Huertas | Contact/lead data submitted via forms (personal data) | High (confidentiality, integrity) | Migrations in `worker/migrations`; Time Travel for point-in-time restore; shared by prod and staging per config, review isolation |
| Customer portal `account.albena.ai` (separate Worker + own D1 database; web in `portal/web`, worker in `portal/worker`) | Customer sign-in (email magic link plus 6-digit code, passkeys), account, hubs, billing views, read-only support view-as | Omar Huertas | Customer account and household data (personal data) | High | Same security headers as albena.ai; support view-as is Access-protected, read-only, 30 minutes, audited; security review `docs/security-review-portal-2026-10-09.md` (11 findings fixed) |
| Cloudflare Email Sending | Outbound sign-in and notification email | Omar Huertas | Recipient address and message content in transit | Medium | SPF, DKIM (cf-bounce selector) and DMARC p=quarantine present for the sending domain; sender accounts@albena.ai |
| Cloudflare R2 (backup bucket) | Target for nightly encrypted D1 exports (RPO 24h) | Omar Huertas | Encrypted D1 exports | High | IMPLEMENTED 2026-10-09 (first run and verification succeeded, `controls/evidence/2026-10-09-status.json`): bucket `albena-backups`, Worker cron 03:17 UTC writes gzip NDJSON + SHA-256 manifest, 35-day retention, weekly verify (`worker/src/maintenance.ts`). |
| Cloudflare Turnstile | Bot protection on forms | Omar Huertas | Challenge tokens, client signals (processed by Cloudflare) | Medium | Site key public (`PUBLIC_TURNSTILE_SITE_KEY` var); secret `TURNSTILE_SECRET_KEY` is a Worker secret |
| Cloudflare zone `albena.ai` (DNS, TLS, WAF, rate limiting) | Edge, DNS, certificates | Omar Huertas | DNS records, edge logs | High | Baseline checked by `scripts/check-cloudflare-baseline.sh`; DNSSEC currently disabled (report) |
| GitHub repo `kaoshotbeatz-ops/albena-site` | Source, CI/CD, issues, Dependabot | Omar Huertas | Source code, workflow secrets (`CLOUDFLARE_API_TOKEN`), no customer data | High (supply chain) | Protections applied by `scripts/apply-github-protections.sh`; Actions pinned to SHAs |
| GitHub Pages (legacy) | Prior hosting; DNS rollback target | Omar Huertas | Static site only | Low (fallback) | See DNS rollback in contingency plan; `CNAME` file in repo |
| DNS registrar (GoDaddy) | Domain registration for albena.ai and related domains | Omar Huertas | Registrant contact data | High (domain takeover risk) | Enforce MFA and registrar lock; nameservers delegated to Cloudflare |
| npm dependencies (`web/`, `worker/`) | Build and runtime libraries | Omar Huertas | None | Medium | SBOM (CycloneDX) generated in CI (`sbom` job) and attached to releases |
| Obvera (owner IT platform) | Change records, incident records | Omar Huertas | Change/incident metadata | Medium | Not part of the production data path |

## Maintenance
- SBOM per release and per CI run: artifact `sbom` (`sbom-web.cdx.json`, `sbom-worker.cdx.json`).
- Review this inventory quarterly and after each architecture change.
