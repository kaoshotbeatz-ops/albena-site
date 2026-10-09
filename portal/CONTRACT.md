# account.albena.ai — Customer Portal contract (lead: Claude)

Separate Cloudflare Worker `albena-portal` at account.albena.ai. Own D1 `albena_portal`. Holds ONLY account, billing, hub-management data — never conversations, memory, camera or home data.

## Layout (each builder owns one area; do not edit others' areas)
- portal/worker/            Hono + TS Worker (skeleton + auth: GPT-6)  -> src/index.ts mounts routers
- portal/worker/src/auth/   passkeys (WebAuthn) + email magic link, sessions        (GPT-6)
- portal/worker/src/billing/ Stripe Checkout, Customer Portal, webhooks, entitlements (Sonnet B)
- portal/worker/src/hubs/   Hub pairing + heartbeat + releases                      (Sonnet C)
- portal/web/               Astro static UI, Linear style                           (Sonnet D)
- portal/docs/              customer help docs                                      (Haiku)

## Module interface
Each module exports `export function mount(app: Hono<AppEnv>): void` and `export const migrations: string[]` file names under portal/worker/migrations/ with its own prefix (0100_auth_*, 0200_billing_*, 0300_hubs_*).
Shared from auth (GPT-6 provides, others import):
- `requireUser` middleware -> sets c.get("user") = { id: string, email: string, role: "owner"|"member" , accountId: string }
- `audit(c, action, target, meta?)` -> hash-chained audit_log (same design as site worker)
- `AppEnv` type in src/types.ts (Bindings: DB, PORTAL_SECRETS..., Variables: user, requestId)
Until auth lands, other builders stub these in `src/_stubs.ts` with identical signatures.

## API (JSON, same-origin, cookie session `__Host-albena_session`, HttpOnly Secure SameSite=Lax; writes need header X-Requested-With: albena-portal)
Auth: POST /api/auth/magic/start {email,turnstileToken} · GET /api/auth/magic/verify?token · POST /api/auth/passkey/register/{options,verify} · POST /api/auth/passkey/login/{options,verify} · POST /api/auth/logout · GET /api/me · GET /api/security/sessions · DELETE /api/security/sessions/:id
Billing: GET /api/billing/summary · POST /api/billing/checkout {plan: "byo"|"hub_mac"|"hub_nvidia"|"estate", interval} -> {url} · POST /api/billing/portal -> {url} · POST /api/stripe/webhook (Stripe-Signature verified, raw body) · GET /api/billing/invoices
Hubs: POST /api/hubs/pair/start (user) -> {code, expiresAt} · POST /api/hubs/pair/complete (hub, code + hub public key) -> {hubId, token} · POST /api/hubs/heartbeat (hub, signed) {version, profile, health} · GET /api/hubs · PATCH /api/hubs/:id {name, updateChannel, remoteAccess} · DELETE /api/hubs/:id · GET /api/releases/latest?edition=
Account: GET/PATCH /api/account · POST /api/account/members/invite · GET /api/account/export · POST /api/account/delete
Support: proxy-free — portal links to albena.ai/support (account-linked tickets later)

## Rules
Stripe TEST mode only (sk_test via secret STRIPE_SECRET_KEY, whsec via STRIPE_WEBHOOK_SECRET); never store card data; prices from Stripe Price IDs in vars. Same security headers/CSP as site worker. Tests with vitest + @cloudflare/vitest-plugin. No deploys, no remote resources — lead integrates and deploys.
