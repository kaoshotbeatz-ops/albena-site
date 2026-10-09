# NIST CSF 2.0 profile (Albena site, Omar Huertas LLC)

Tiers: 1 Partial, 2 Risk Informed, 3 Repeatable, 4 Adaptive. "Current" is an honest self-assessment dated 2026-10-09; "Target" is the 12-month goal appropriate for a very small organization. This is an internal profile, not a certification.

| Function | Category focus | Current | Target | Basis / next step |
|----------|----------------|---------|--------|-------------------|
| GV Govern | GV.OC context, GV.RM strategy, GV.RR roles, GV.PO policy, GV.OV oversight, GV.SC supply chain | Tier 1 | Tier 3 | Policies exist only as DRAFT; approve and review annually; vendor register and SOC report reviews (GAPS G-01, G-04) |
| ID Identify | ID.AM assets, ID.RA risk, ID.IM improvement | Tier 2 | Tier 3 | Dependencies and components visible in repo; no formal asset inventory or risk assessment; add Obvera CMDB entries and annual risk assessment |
| PR Protect | PR.AA access, PR.AT awareness, PR.DS data, PR.PS platform, PR.IR resilience | Tier 2 | Tier 3 | Access gating, TLS/headers (post-cutover), secrets handling, CI controls; missing training, token rotation, access reviews |
| DE Detect | DE.CM monitoring, DE.AE adverse event analysis | Tier 1 | Tier 2 | Scans in CI and audit_log exist; no alerting or log review cadence |
| RS Respond | RS.MA incident management, RS.AN analysis, RS.CO comms, RS.MI mitigation | Tier 1 | Tier 2 | IR policy is DRAFT; run a tabletop exercise |
| RC Recover | RC.RP recovery plan execution, RC.CO comms | Tier 1 | Tier 2 | Code redeploys from git; D1 backup and restore untested (GAPS G-03) |

Crosswalk: see `nist-800-53-moderate.csv` (families map roughly: AC/IA/SC to PR, AU/SI/CA to DE, IR to RS, CP to RC, PM/PL/RA/SA/SR to GV and ID).
