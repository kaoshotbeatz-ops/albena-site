# albena-site worker

Cloudflare Worker for albena.ai: serves the static frontend (Workers Static Assets from `../web/dist`) and the API. TypeScript, Hono, zod, jose, D1.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | liveness |
| GET | `/api/config` | `{turnstileSiteKey}` for the frontend widget |
| POST | `/api/waitlist` | `{email, name?, interest?, turnstileToken, website}`; 201 new, 200 duplicate/honeypot |
| POST | `/api/support` | `{name, email, topic, message<=4000, turnstileToken, website}`; 201 `{id:"ALB-000123"}` |
| GET | `/api/admin/waitlist`, `/api/admin/tickets?status=&limit=&offset=` | Access JWT required |
| PATCH | `/api/admin/tickets/ALB-000123` `{status}` | open / in_progress / resolved / closed |
| GET | `/api/admin/export/{waitlist,tickets}.csv` | CSV (formula-injection guarded) |
| any | `/admin/*` | static admin pages, served only after Access JWT verification |

`website` is the honeypot field: hidden in the form, must stay empty. POSTs are same-origin only (no CORS headers), rate limited to 5 req / 60 s per IP per route, and Turnstile-verified server side. IPs are stored only as `SHA-256(IP_SALT:ip)`. Every write and admin action is recorded in `audit_log`. `www.albena.ai` 301-redirects to the apex. All responses (including static assets) get the security headers; `/api` and `/admin` are `no-store`.

Notes: wrangler's name for `html_handling: "auto"` is `auto-trailing-slash`. The Worker runs first (`run_worker_first`) so assets pass through the header middleware.

## One-time setup (nothing here has been run)

```sh
cd worker
npm install

# 1. Database
npx wrangler d1 create albena            # copy database_id into wrangler.jsonc (replace TO_BE_CREATED)
npx wrangler d1 migrations apply albena --remote

# 2. Turnstile: create a widget for albena.ai in the dashboard, then:
#    put the site key in wrangler.jsonc vars.TURNSTILE_SITE_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put IP_SALT          # long random string, e.g. `openssl rand -hex 32`

# 3. Cloudflare Access: create a self-hosted app covering albena.ai/admin* and albena.ai/api/admin*
#    with an allow policy for Omar only.
npx wrangler secret put ADMIN_AUD        # the application's AUD tag
npx wrangler secret put TEAM_DOMAIN      # e.g. yourteam.cloudflareaccess.com

# 4. Optional email notifications: enable Email Routing for albena.ai and verify
#    omar@dbaomarhuertasllc.com as a destination address (NOTIFY_FROM must be on that zone).
#    Without it the notify step silently no-ops.

# 5. Build ../web (outputs ../web/dist), then
npx wrangler deploy
```

Remove or leave the `routes` custom domains as needed; the zone for albena.ai must be on this Cloudflare account.

## Development

```sh
npm test            # vitest + @cloudflare/vitest-pool-workers (needs ../web/dist/index.html to exist)
npm run typecheck
npm run migrate:local && npm run dev   # wrangler dev --local
```

Local use of Node 24: `export PATH=$(brew --prefix node@24)/bin:$PATH`.
Tests set `compatibilityDate` to the newest date the bundled local workerd supports (the production date is `2026-10-01` in `wrangler.jsonc`); `wrangler dev --local` may need the same temporary override if its workerd is older. `@cloudflare/vitest-pool-workers` is deprecated in favour of `@cloudflare/vitest-plugin`; migrate with `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin` when convenient.
