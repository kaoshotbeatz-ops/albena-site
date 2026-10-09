# Tabletop exercise 2026 Q4 (NIST IR-3, IR-8)

> Scenario script. Exercise date: ______ (schedule before 2026-12-31). Facilitator and scribe: Omar Huertas (add a second participant if available).

## Objectives
Practice the `incident-response.md` runbook: detection, severity call, containment decisions, notification decisions, recovery, and review. Find gaps in contacts, access and backups.

## Scenario
**Inject 1 (T+0).** The weekly scheduled-security workflow opens a `security` issue: gitleaks reports a Cloudflare API token committed in a past commit. Cloudflare dashboard shows the token was used from an unfamiliar IP 3 hours ago.
Discuss: Severity? Who is told? What is preserved before changes?

**Inject 2 (T+30 min).** Audit log shows the Worker was redeployed with a modified script, and a DNS record for `www` was changed.
Discuss: Revoke token now? How do you verify what the Worker serves? Do you roll back with `wrangler rollback` or redeploy from a tagged commit? Do you revert DNS to GitHub Pages?

**Inject 3 (T+2 h).** D1 query logs show a bulk read of the submissions table. It holds names and email addresses, including EU and California residents.
Discuss: Is this a personal data breach? GDPR 72-hour clock start time? US state notice duties? Who is the counsel contact? What do you tell affected people?

**Inject 4 (T+6 h).** Site restored. A reporter emails claiming they found the exposure first and asks for acknowledgement.
Discuss: Response per `SECURITY.md`; what is said publicly.

## Questions to record
- Time to detect, triage, contain (target: contain within 1 hour in the exercise).
- Were all contacts and credentials available? Did MFA recovery work?
- Could D1 be restored to a point before the incident (Time Travel / export)? Was RPO 24h / RTO 4h achievable?
- What would be missing from the evidence?

## Outputs
- Filled-in timeline and decisions.
- Action list with owners and dates (add to `controls/GAPS.md`).
- Update runbooks; record the exercise in an Obvera record; file the result under `controls/evidence/`.
