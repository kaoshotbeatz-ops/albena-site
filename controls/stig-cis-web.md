# Web, TLS and header hardening checks (DISA STIG / CIS-aligned)

Scope: albena.ai public site and Worker API on Cloudflare. Host OS, web-server daemon and database STIG items (e.g. Apache/IIS/Nginx, OS-level CIS benchmarks) are **not applicable** because the platform is serverless and hardening of those layers is inherited from Cloudflare. This table is a tailored, application-layer subset, not a claim of STIG or CIS conformance. Reference sets used for selection: DISA Application Security and Development STIG, DISA Web Server SRG, CIS Benchmarks for web servers (mapped conceptually), OWASP Secure Headers Project.

Status key: auto = checked by CI or post-deploy script; manual = periodic human check; inherited = provider responsibility (collect vendor report).

| # | Check | Expectation | Verified by | NIST |
|---|-------|-------------|-------------|------|
| 1 | HTTPS only; HTTP redirects to HTTPS | 301/308 from http:// to https:// | auto: `scripts/check-headers.sh` (redirect test) | SC-8 |
| 2 | HSTS | `Strict-Transport-Security` max-age >= 31536000, includeSubDomains | auto: `scripts/check-headers.sh` | SC-8, SC-23 |
| 3 | TLS protocol floor | TLS 1.2 minimum, 1.3 enabled; SSLv3/TLS1.0/1.1 off | auto: ZAP/`curl --tlsv1.2`; manual: Cloudflare "Minimum TLS Version" setting; inherited | SC-8, SC-13 |
| 4 | Strong ciphers, valid certificate chain | No weak ciphers; cert not expiring within 14 days | auto: `check-headers.sh` cert expiry via curl; inherited ciphers | SC-12, SC-17 |
| 5 | Content-Security-Policy | Present; no `unsafe-eval`; `frame-ancestors` set; `object-src 'none'`; `base-uri` restricted | auto: `check-headers.sh` | SC-18, SI-10 |
| 6 | Clickjacking protection | `X-Frame-Options` DENY/SAMEORIGIN and CSP `frame-ancestors` | auto: `check-headers.sh` | SC-18 |
| 7 | MIME sniffing | `X-Content-Type-Options: nosniff` | auto: `check-headers.sh` | SI-10 |
| 8 | Referrer policy | `Referrer-Policy` set (strict-origin-when-cross-origin or stricter) | auto: `check-headers.sh` | AC-4 |
| 9 | Permissions policy | `Permissions-Policy` set, sensors/camera/mic denied | auto: `check-headers.sh` | CM-7 |
| 10 | Server/version disclosure | No `X-Powered-By`; Server header carries no version | auto: `check-headers.sh` (warns) | CM-6, SI-11 |
| 11 | Cookie flags (if cookies set) | Secure, HttpOnly, SameSite | auto: ZAP baseline; `check-headers.sh` warns on Set-Cookie without flags | SC-23 |
| 12 | CORS | No wildcard `Access-Control-Allow-Origin` on authenticated or API routes | auto: `check-headers.sh` (warns); note GitHub Pages sets `*` today | AC-4 |
| 13 | Admin surface behind Access | Unauthenticated request to admin path returns redirect to Access login or 401/403 | auto: planned extra step in post-deploy (add admin path to `check-headers.sh --admin-path`) | AC-3, IA-2 |
| 14 | Error handling | No stack traces or framework banners in 4xx/5xx | auto: ZAP baseline | SI-11 |
| 15 | Input validation / injection | No reflected XSS or SQLi on forms | auto: Semgrep SAST in CI; ZAP baseline (passive) | SI-10 |
| 16 | Rate limiting | Excess requests to forms return 429 | manual: periodic test; auto test planned in worker tests | AC-7, SC-5 |
| 17 | Bot/abuse control on forms | Turnstile token required server-side | auto: worker tests (when present) | SI-8 |
| 18 | Security.txt / contact | `/.well-known/security.txt` present | manual (planned addition to site) | IR-6 |
| 19 | Dependencies free of high vulns | `npm audit --audit-level=high` clean | auto: CI | SI-2, RA-5 |
| 20 | No secrets in repo | gitleaks clean | auto: CI | IA-5, SA-11 |
| 21 | Accessibility baseline | Lighthouse accessibility >= 95 | auto: CI | (SOC 2 / Section 508 support) |
| 22 | DNSSEC and CAA | DNSSEC enabled; CAA restricts issuers | manual: Cloudflare DNS; inherited | SC-20, SC-22 |
| 23 | Web server/OS CIS benchmark | Not applicable (serverless) | inherited: Cloudflare SOC 2 / ISO 27001 reports | CM-6 |

Known current state (2026-10-09): the live site is served by GitHub Pages and does not yet send the full header set; `scripts/check-headers.sh https://albena.ai` is expected to fail on HSTS/CSP/XFO/Permissions-Policy until the Cloudflare Worker cutover. The post-deploy check runs against the Worker deployment and will flip the related NIST controls (SC-8, SC-18, CM-6) from partial to implemented once green.
