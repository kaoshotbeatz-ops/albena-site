## What and why
<!-- Short description -->

## Change record
- [ ] Obvera Change id: `CHG-________` (required for anything deployed to production)
- [ ] Risk: low / medium / high — why:
- [ ] Rollback plan:

## Checklist
- [ ] CI is green (build, worker tests, gitleaks, npm audit, Semgrep, accessibility)
- [ ] No secrets, tokens or personal data in the diff
- [ ] Security headers/CSP unaffected, or `scripts/check-headers.sh` updated and passing
- [ ] If controls changed: updated `controls/*.csv` and ran `node scripts/build-controls.mjs`
- [ ] Privacy impact considered (new data collected? update privacy.html and retention policy)
- [ ] Reviewed by a CODEOWNER; production deploy approval requested
