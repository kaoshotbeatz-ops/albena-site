# Gap list and owner to-do (prioritized)

> **No public claim of compliance or certification.** Do not state or imply that albena.ai or Omar Huertas LLC is "SOC 2 compliant", "NIST 800-53 compliant", "STIG/CIS compliant" or "certified" until an independent auditor issues a report. The site's controls page may say only that controls are being "mapped to" or "aligned with" frameworks, with the status shown. SOC 2 is an attestation by a licensed CPA firm; NIST 800-53 and CSF are frameworks, not certifications.

Snapshot (2026-10-09, re-scored after Cloudflare Access and GitHub protections went live): see `nist-800-53-moderate.csv`. Counts: 176 baseline controls; 35 implemented, 80 partial, 54 planned, 7 not applicable. 49 controls are inherited (47 Cloudflare, 2 GitHub) and depend on obtaining vendor assurance.

## Closed
| ID | Gap | Closed by |
|----|-----|-----------|
| G-05 | Worker cutover not live | Worker is live on albena.ai; header gate and TLS scan pass; Cloudflare zone baseline recorded in `controls/evidence/2026-10-09-cloudflare-baseline.json` (2026-10-09) |
| G-15a | SBOM and vendor register | CycloneDX SBOM job in `.github/workflows/ci.yml`; `controls/vendor-register.md` and `controls/inventory.md` written (DRAFT, awaiting approval) |
| G-13a | Retention enforcement in code | Nightly ticket anonymization and 35-day backup pruning in `worker/src/maintenance.ts` (policy approval still open under G-01) |
| G-02 | Branch protection and approvals | Applied 2026-10-09 via `scripts/apply-github-protections.sh`: PR, 1 CODEOWNERS review, stale-review dismissal, 7 required checks, linear history, no force push/deletion, conversation resolution; secret scanning, push protection, Dependabot alerts and security updates; environment `production` with required reviewer. Evidence: `controls/evidence/2026-10-09-github-protections.json`. Org-wide 2FA still to evidence (G-12). **Residual risk: `enforce_admins` is false (sole owner can bypass); commit signing not required** |
| G-19 | Cloudflare Access | Live 2026-10-09 on albena.ai/admin and /api/admin: email one-time PIN, owner-only allow policy, 8h session, HttpOnly + SameSite=Strict cookies; Worker verifies the Access JWT, deny-by-default. Evidence: `controls/evidence/2026-10-09-access-app.json`. Email OTP is single factor, not MFA (see G-12). Access logs are kept 24h on the Free plan; Albena's hash-chained audit_log is the long-term record. Flipped AC-3 and AC-12 |
| G-08a | Tamper-evident audit log | Hash-chained audit_log, migration 0002, verified on each backup (`worker/src/auditchain.ts`) |

## P0 (do first, this month). Owner: Omar unless noted
| ID | Gap | What remains |
|----|-----|--------------|
| G-01 | Policies are DRAFT only | Review and approve the 8 policies in `controls/policies/` (plus contingency and IR runbooks), sign and date, store approved copies (Obvera KB) and set an annual review date. Blocks many `-1` controls and moves several partial controls to implemented |
| G-03 | Backups unproven | Nightly R2 backup is deployed; first run 2026-10-10 03:17 UTC. Then confirm `/api/status` lastBackupOk=true, record the first weekly verification (Sunday) and perform one full restore drill per `worker/RUNBOOK-restore.md`. Then flip CP-9, CP-4, A1.3 |
| G-04 | Vendor assurance missing | Download Cloudflare SOC 2 Type II and ISO 27001 reports and GitHub SOC 2 Type II/ISAE report, file them, record review date and CUECs; note Turnstile is covered by Cloudflare |

## P1 (next 60 days). Owner: Omar
| ID | Gap | Action |
|----|-----|--------|
| G-06 | Access reviews | Quarterly review of GitHub org, Cloudflare account and Access policy members; record outcome (AC-2, CC6.3) |
| G-07 | Token and secret rotation | Rotate Cloudflare token every 90 days; record in Obvera (IA-5) |
| G-08 | Audit log review and alerting | Monthly audit_log review; alert on backup/audit failure and admin anomalies (AU-5, AU-6, CC7.2) |
| G-09 | Incident response test | Run the tabletop in `controls/runbooks/tabletop-2026Q4.md`; define breach notification steps (IR-3, P6.6) |
| G-10 | Risk assessment | Complete a documented risk assessment and categorize data (RA-2, RA-3) |
| G-11 | Training | Record annual security and privacy awareness for operator and any contractors (AT-2) |
| G-12 | MFA evidence | Capture screenshots/exports showing MFA enforced on GitHub, Cloudflare and the mailbox used for Access one-time PIN (Access OTP alone is single factor; IA-2 stays partial until then) |
| G-20 | Admin bypass | Consider enabling `enforce_admins` once a second maintainer exists, and require signed commits (CM-5) |

## P2 (next 6 months). Owner: Omar / team
| ID | Gap | Action |
|----|-----|--------|
| G-14 | Privacy operations | Subject access/correction procedure, processor list, DPAs (P5-P6) |
| G-15 | Supply chain | npm provenance checks, formal supply chain risk policy approval (SR-3, SR-6) |
| G-16 | Personnel security | Contractor access agreements and offboarding checklist (PS family) |
| G-17 | DNSSEC, admin banner, CAA | Enable DNSSEC (currently disabled) and add DS at registrar; admin use-notification banner (AC-8, SC-20) |
| G-18 | ZAP blocking | After two clean baseline runs, remove `continue-on-error` and fail on medium alerts |

## Auditor readiness steps (SOC 2)
1. Decide scope: Security first (Common Criteria), add Availability/Confidentiality/Privacy later. A Type I (point in time) before Type II.
2. Approve policies and run controls for a full observation window (typically 3 to 12 months for Type II) with evidence collected monthly.
3. Evidence to keep: access review records, PR/Obvera Change records, CI run history, vendor reports, incident/tabletop notes, restore test, training records, risk assessment.
4. Pick a readiness tool or advisor (optional) and a CPA firm; request a readiness assessment against this mapping (`soc2-tsc.csv`).
5. Inherited controls: auditor will rely on Cloudflare/GitHub reports as subservice organizations (carve-out); you must show you reviewed them and implemented their CUECs.

Honesty note: statuses were re-scored on 2026-10-09 against what is live and evidenced. A control is "implemented" only where the cited file, workflow or evidence exists today; items awaiting an Omar action (policy approval, MFA evidence, first backup run, CI deploy secret) are "partial" and name the blocker in the implementation text. Nothing here is a certification or audit result.