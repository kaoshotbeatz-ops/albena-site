# NIST CSF 2.0 profile (Albena site, Omar Huertas LLC)

Tiers: 1 Partial, 2 Risk Informed, 3 Repeatable, 4 Adaptive. "Current" is an honest self-assessment dated 2026-10-09; "Target" is the 12-month goal appropriate for a very small organization. This is an internal profile, not a certification.

| Function | Category focus | Current | Target | Basis / next step |
|----------|----------------|---------|--------|-------------------|
| GV Govern | GV.OC context, GV.RM strategy, GV.RR roles, GV.PO policy, GV.OV oversight, GV.SC supply chain | Tier 1 | Tier 3 | Policies, vendor register and inventory exist only as DRAFT; approve and review annually; SOC report reviews (GAPS G-01, G-04) |
| ID Identify | ID.AM assets, ID.RA risk, ID.IM improvement | Tier 2 | Tier 3 | Dependencies and components visible in repo; no formal asset inventory or risk assessment; add Obvera CMDB entries and annual risk assessment |
| PR Protect | PR.AA access, PR.AT awareness, PR.DS data, PR.PS platform, PR.IR resilience | Tier 2 | Tier 3 | TLS/HSTS preload and CSP verified live, rate limiting, Turnstile, encrypted-at-rest backups, CI controls; Cloudflare Access (owner-only, 8h session) and GitHub branch protection now live (enforce_admins=false residual); missing MFA evidence, training, token rotation, access reviews |
| DE Detect | DE.CM monitoring, DE.AE adverse event analysis | Tier 2 | Tier 2 | Weekly scheduled security scans auto-file issues, tamper-evident audit_log and backup status indicator exist; no alerting or log review cadence yet |
| RS Respond | RS.MA incident management, RS.AN analysis, RS.CO comms, RS.MI mitigation | Tier 1 | Tier 2 | IR policy and runbook are DRAFT; tabletop script written, not yet run |
| RC Recover | RC.RP recovery plan execution, RC.CO comms | Tier 1 | Tier 2 | Nightly R2 backups with weekly verification are deployed (first run 2026-10-10); restore not yet drilled (GAPS G-03) |

Crosswalk: see `nist-800-53-moderate.csv` (families map roughly: AC/IA/SC to PR, AU/SI/CA to DE, IR to RS, CP to RC, PM/PL/RA/SA/SR to GV and ID).
