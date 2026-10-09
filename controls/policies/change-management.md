# Change Management Policy

> **DRAFT for Omar's approval. Not in effect until approved, signed and dated.** Owner: Omar Huertas, Omar Huertas LLC. Review: annually. Approved: ____ (date) by ____.

## Purpose
Every production change is reviewed, tested, approved and traceable.

## Policy
1. All changes go through a pull request into main; direct pushes to main are prohibited by branch protection.
2. Each PR records an Obvera Change id, risk, rollback plan and test evidence (PR template).
3. CI must pass: build, worker tests, secret scan, dependency audit, SAST, accessibility.
4. Production deploys require approval via the GitHub 'production' environment and run only from main.
5. Emergency changes follow the same path where possible; otherwise record a retroactive Change within one business day.
6. After deploy, post-deploy header checks and ZAP baseline run; failures open an issue.
7. Infrastructure and configuration live in the repository (wrangler config); manual dashboard changes are recorded as Changes and reflected in code.

## Compliance and exceptions
Violations are handled by the owner. Exceptions are written, time-limited and recorded in an Obvera Change.
