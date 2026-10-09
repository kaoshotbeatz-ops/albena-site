# Gap list and owner to-do (prioritized)

> **No public claim of compliance or certification.** Do not state or imply that albena.ai or Omar Huertas LLC is "SOC 2 compliant", "NIST 800-53 compliant", "STIG/CIS compliant" or "certified" until an independent auditor issues a report. The site's controls page may say only that controls are being "mapped to" or "aligned with" frameworks, with the status shown. SOC 2 is an attestation by a licensed CPA firm; NIST 800-53 and CSF are frameworks, not certifications.

Snapshot (2026-10-09): see `nist-800-53-moderate.csv`. Counts: 176 baseline controls; 21 implemented, 87 partial, 61 planned, 7 not applicable. 49 controls are inherited (47 Cloudflare, 2 GitHub) and depend on obtaining vendor assurance.

## P0 (do first, this month)
| ID | Gap | What Omar must do |
|----|-----|-------------------|
| G-01 | Policies are DRAFT only | Review and approve the 8 policies in `controls/policies/`, sign and date, store approved copies (Obvera KB) and set an annual review date |
| G-02 | Branch protection and approvals | In GitHub: require PR + passing checks on main, require CODEOWNERS review, create environment `production` with required reviewer; add secret `CLOUDFLARE_API_TOKEN` (least-privilege token); enforce 2FA for the org |
| G-03 | Backups untested | Schedule a D1 export, store encrypted copy, perform and record a restore test (CP-4, CP-9, A1.3) |
| G-04 | Vendor assurance missing | Download Cloudflare SOC 2 Type II and ISO 27001 reports and GitHub SOC 2 Type II/ISAE report (trust portals), file them, record review date and complementary user entity controls (CUECs); note Turnstile is covered by Cloudflare |
| G-05 | Worker cutover not live | Deploy Worker so headers/HSTS/CSP/rate limiting apply; run `scripts/check-headers.sh https://albena.ai` until green |

## P1 (next 60 days)
| ID | Gap | Action |
|----|-----|--------|
| G-06 | Access reviews | Quarterly review of GitHub org, Cloudflare account and Access policy members; record outcome (AC-2, CC6.3) |
| G-07 | Token and secret rotation | Rotate Cloudflare token every 90 days; record in Obvera (IA-5) |
| G-08 | Audit log review and alerting | Monthly audit_log review; alert on audit write failure and admin anomalies (AU-5, AU-6, CC7.2) |
| G-09 | Incident response test | Tabletop exercise per IR policy; define breach notification steps (IR-3, P6.6) |
| G-10 | Risk assessment | Complete a documented risk assessment and categorize data (RA-2, RA-3) |
| G-11 | Training | Record annual security and privacy awareness for operator and any contractors (AT-2) |
| G-12 | MFA evidence | Capture screenshots/exports showing MFA enforced on GitHub, Cloudflare and IdP |

## P2 (next 6 months)
| ID | Gap | Action |
|----|-----|--------|
| G-13 | Data retention enforcement | Implement retention and deletion for waitlist/support/audit data per policy (SI-12, P4.2, P4.3) |
| G-14 | Privacy operations | Subject access/correction procedure, processor list, DPAs (P5-P6) |
| G-15 | Supply chain | Vendor register, SBOM generation, npm provenance checks (SR-3, SR-6) |
| G-16 | Personnel security | Contractor access agreements and offboarding checklist (PS family) |
| G-17 | security.txt, admin banner, DNSSEC/CAA | Small hardening items (AC-8, SC-20) |
| G-18 | ZAP blocking | After two clean baseline runs, remove `continue-on-error` and fail on medium alerts |

## Auditor readiness steps (SOC 2)
1. Decide scope: Security first (Common Criteria), add Availability/Confidentiality/Privacy later. A Type I (point in time) before Type II.
2. Approve policies and run controls for a full observation window (typically 3 to 12 months for Type II) with evidence collected monthly.
3. Evidence to keep: access review records, PR/Obvera Change records, CI run history, vendor reports, incident/tabletop notes, restore test, training records, risk assessment.
4. Pick a readiness tool or advisor (optional) and a CPA firm; request a readiness assessment against this mapping (`soc2-tsc.csv`).
5. Inherited controls: auditor will rely on Cloudflare/GitHub reports as subservice organizations (carve-out); you must show you reviewed them and implemented their CUECs.

Honesty note: counts above reflect repo and design as of this branch. Items marked implemented that depend on merged CI (e.g. RA-5, SI-2) are true only after this branch is merged and branch protection is enabled.
