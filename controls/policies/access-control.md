# Access Control Policy

> **DRAFT for Omar's approval. Not in effect until approved, signed and dated.** Owner: Omar Huertas, Omar Huertas LLC. Review: annually. Approved: ____ (date) by ____.

## Purpose
Grant the minimum access needed, to named individuals, with strong authentication.

## Policy
1. All administrative access (GitHub, Cloudflare, identity provider, registrar) uses unique accounts with MFA; shared accounts are prohibited.
2. Admin routes are reachable only through Cloudflare Access and require a named identity.
3. Least privilege: use scoped API tokens; CI tokens are limited to deploying the Worker; no global API keys.
4. Provision and remove access through a recorded request; remove access on the day roles end.
5. Review all privileged access quarterly and keep the record.
6. Secrets live only in GitHub Actions secrets or Cloudflare secret stores; rotate every 90 days or on suspected exposure.
7. Break-glass: document recovery codes stored offline.

## Compliance and exceptions
Violations are handled by the owner. Exceptions are written, time-limited and recorded in an Obvera Change.
