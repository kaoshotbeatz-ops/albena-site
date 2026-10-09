# Incident Response and Contingency Policy

> **DRAFT for Omar's approval. Not in effect until approved, signed and dated.** Owner: Omar Huertas, Omar Huertas LLC. Review: annually. Approved: ____ (date) by ____.

## Purpose
Detect, contain, eradicate and recover from security incidents and outages, and notify as required.

## Policy
1. Report suspected incidents via SECURITY.md channel or directly to the owner; every report gets an Obvera incident record.
2. Phases: triage and severity, contain (disable token/route, Access block), eradicate, recover (redeploy from git, restore D1), review.
3. Severity 1 (data exposure or site takeover): act immediately, preserve logs, rotate credentials, notify affected people and regulators as law requires without undue delay.
4. Post-incident review within 5 business days; update controls and GAPS.md.
5. Contingency: code recovers by redeploying main; D1 data recovers from the latest verified export or Time Travel.
6. Test the plan with a tabletop exercise and a restore test at least annually.

## Compliance and exceptions
Violations are handled by the owner. Exceptions are written, time-limited and recorded in an Obvera Change.
