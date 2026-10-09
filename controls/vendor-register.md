# Vendor and third-party register (NIST SA-9, SR-6)

> DRAFT for owner review. Snapshot 2026-10-09. No vendor assurance reports have been obtained or filed yet; each "Action" below is open until the document is downloaded, reviewed and stored.

| Vendor | Services used | Data shared | Assurance available | Action (open) | Owner |
|---|---|---|---|---|---|
| Cloudflare | Workers, D1, R2 (planned), Turnstile, DNS/CDN/WAF, TLS | Site traffic and request metadata, form submissions, DNS records, Turnstile signals | SOC 2 Type II, ISO/IEC 27001 and related reports via the Cloudflare dashboard (Compliance Resources) | Obtain and file the current SOC 2 Type II and ISO 27001 certificate; review complementary user entity controls and sub-processor list; record date reviewed | Omar Huertas |
| GitHub (Microsoft) | Source hosting, Actions CI/CD, Dependabot, secret scanning, Pages (legacy) | Source code, workflow secrets, repo metadata; no customer data | SOC 1/SOC 2 reports and ISO 27001 via GitHub Trust Center (requires Enterprise/customer access to some reports) | Obtain and file the latest SOC report or bridge letter available to the account; note any access limitation | Omar Huertas |
| GoDaddy (registrar) | Domain registration and renewal | Registrant contact data, account credentials | Vendor trust/compliance statements on the vendor's public site | Obtain and file available assurance (SOC or equivalent); confirm MFA and registrar lock on all domains | Omar Huertas |
| Google Fonts | Not used. Fonts are self-hosted (`@fontsource-variable/inter`), so no visitor data goes to Google | None | n/a | Keep the no-external-font rule; verify CSP blocks `fonts.googleapis.com` | Omar Huertas |

## Process
1. Before adopting a vendor: record the service, data shared, and location of assurance reports here, and obtain the report.
2. Review annually and on material change; record the review date and findings.
3. Reports and reviews are stored with the evidence (not in the public repo if confidential under NDA).
4. Link: `policies/vendor-management.md`, `inventory.md`.
