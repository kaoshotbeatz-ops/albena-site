# Incident response runbook (NIST IR-1, IR-4, IR-6, IR-8)

> DRAFT for owner approval. Implements `controls/policies/incident-response.md`. Owner: Omar Huertas.

## Roles and contacts
| Role | Who | Contact |
|---|---|---|
| Incident commander / decision maker | Omar Huertas | omar@dbaomarhuertasllc.com |
| Reporter intake | Security reports per `SECURITY.md` | GitHub private advisory or email subject "albena.ai security" |
| Cloudflare support | Vendor | Dashboard support case; abuse and security via Cloudflare support portal |
| GitHub support | Vendor | GitHub Support / security advisories |
| Legal counsel | TO BE NAMED | ______ |
| Cyber insurance / forensic firm | TO BE NAMED | ______ |

Fill the blank rows before approval. Every incident gets an Obvera incident record and, for any change made, an Obvera Change.

## Severity
- Sev 1: confirmed exposure of personal data, site takeover, credential compromise with production access. Act immediately.
- Sev 2: vulnerability being exploited without confirmed data loss; extended outage (> RTO).
- Sev 3: suspected issue, contained, or minor outage.

## Phases
1. **Detect.** Sources: scheduled-security issue (label `security`), Cloudflare alerts/WAF events, GitHub secret scanning alerts, reporter email/advisory, uptime monitoring. Record time of detection and who reported.
2. **Triage.** Open an Obvera incident. Assign severity, scope (which component per `inventory.md`), whether personal data is involved. Start an incident log (timestamped, append-only).
3. **Contain.** Choose the least destructive effective action: rotate/revoke the affected token (`CLOUDFLARE_API_TOKEN`, `TURNSTILE_SECRET_KEY`); block routes or add a WAF rule; enable "Under Attack" mode; disable the Worker route; revert DNS to the GitHub Pages fallback (see contingency plan). Preserve evidence first: export Cloudflare logs, Actions logs, `git log`, D1 Time Travel bookmark.
4. **Eradicate.** Remove root cause: patch dependency, remove malicious commit/workflow, rotate all secrets that could have been exposed, review GitHub audit log and Cloudflare audit log for unauthorized changes.
5. **Recover.** Redeploy from a known-good commit (`wrangler deploy` from tagged main, or `wrangler rollback`); restore D1 from Time Travel or the latest verified export if data integrity is affected; verify with `scripts/check-headers.sh`, `scripts/check-cloudflare-baseline.sh`, `scripts/check-tls.sh`; monitor for recurrence for 7 days.
6. **Lessons learned.** Post-incident review within 5 business days: timeline, root cause, what worked, actions with owners and dates. Update controls, `GAPS.md`, this runbook. Close the Obvera incident.

## Breach notification (decision aid, not legal advice)
Consult counsel at Sev 1. Start the clock at the time the incident is **discovered/confirmed**.
- **GDPR (EU/UK residents' data):** notify the supervisory authority within **72 hours** of becoming aware of a personal data breach unless unlikely to result in risk (Art. 33); notify affected individuals without undue delay if high risk (Art. 34).
- **US state laws:** all 50 states require notice to affected residents; deadlines vary and many require "without unreasonable delay". Examples with fixed limits: Florida 30 days, Colorado 30 days, Washington 30 days, Texas 60 days (and Attorney General notice if 250+ residents within 30 days). Many states also require notice to the state Attorney General above a resident-count threshold. Confirm the current law for each affected state (the site collects only form submissions; determine which states' residents are in the data).
- **Contractual:** notify customers/partners per any agreement terms.
- Record: what was notified, to whom, when, and the content sent. Notifications are sent by the owner after counsel review.

## Evidence and communications
- Keep one factual timeline; do not speculate in public channels. Public statements only via the owner.
- Do not claim certification or compliance in any communication (see `GAPS.md`).

## Testing
Tabletop at least annually: see `tabletop-2026Q4.md`. Restore test per `contingency-plan.md`.
