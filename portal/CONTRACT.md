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
Each module exports `mount(app: Hono<AppEnv>): void` and `migrations: string[]` (file names under portal/worker/migrations/: 0100_auth_*, 0200_billing_*, 0300_hubs_*). Modules are registered statically in `src/modules.ts`: auth, billing, hubs, account.
Shared from auth: `requireUser` (sets `c.get("user")` = `{ id, email, role: "owner"|"member", accountId }`), `audit(c, action, target, meta?)` (hash-chained audit_log) and `AppEnv` (src/types.ts).
Entitlements: one function, `getEntitlement(db: D1Database, accountId)` in billing, returns `{ plan, status, active, maxHubs, billingInterval, currentPeriodEnd, cancelAtPeriodEnd, stripeSubscriptionId }`. `maxHubs` comes from `MAX_HUBS` in billing/plans.ts (byo 1, hub_mac 1, hub_nvidia 1, estate 5, none 0) and is 0 unless `active` (status active or trialing).

## API
JSON, same-origin, cookie session `__Host-albena_session` (HttpOnly Secure SameSite=Lax). Browser writes need header `X-Requested-With: albena-portal` (and Origin, if sent, must be the portal origin). Machine routes (Stripe webhook, hub pair/complete, hub heartbeat) are exempt from that and authenticate themselves. Times are unix seconds unless noted. Errors are `{ error: "<code>" }`.

Auth
- POST /api/auth/magic/start `{email, turnstileToken}` (Turnstile action `magic_login`) -> 202 `{ok, message}` always (enumeration-safe)
- GET /api/auth/magic/verify?token=... -> 303 to `/`. Single-use, 15 min, stored hashed, and bound to the browser that asked (HttpOnly cookie). Opening it on another device fails by design (see HANDOFF.md).
- POST /api/auth/passkey/register/options -> bare WebAuthn options; POST .../register/verify (raw browser response) -> `{ok}`
- POST /api/auth/passkey/login/options -> bare WebAuthn options (discoverable); POST .../login/verify (raw browser response) -> `{ok}`. The challenge lives server-side, bound to a cookie, single use.
- POST /api/auth/logout -> `{ok}`
- GET /api/me -> `{user: {id, email, role, accountId}}`

Security
- GET /api/security/sessions -> `{sessions: [{id, createdAt, lastSeen, expiresAt, current}]}`; DELETE /api/security/sessions/:id -> `{ok}` (404 if not yours)
- GET /api/security/history -> `{events: [{at, method: "passkey"|"magic_link"}]}` newest first, max 50. `at` is ISO-8601. From the audit chain; successful sign-ins only.
- GET /api/security/passkeys -> `{passkeys: [{id, createdAt}]}`; DELETE /api/security/passkeys/:id -> `{ok}` (404 if not yours). Removing the last passkey is allowed because the email link always works.

Billing
- GET /api/billing/summary -> `{entitlement: {...as above}, hasBillingAccount}`
- GET /api/billing/orders -> `{orders: [{id, plan, shippingStatus, refunded, amountTotal, currency, createdAt}]}` (hardware orders; shippingStatus: pending_fulfillment|shipped|delivered|cancelled_refunded)
- GET /api/billing/invoices -> `{invoices: [{id, number, status, amountPaid, amountDue, currency, created, hostedInvoiceUrl, pdf}]}`
- POST /api/billing/checkout `{plan: "byo"|"hub_mac"|"hub_nvidia"|"estate", interval: "monthly"|"annual"}` -> `{url}` (estate: 400 `contact_sales`; unconfigured price: 503; already subscribed: 409)
- POST /api/billing/portal -> `{url}`
- POST /api/stripe/webhook (Stripe-Signature over the raw body)

Hubs
- POST /api/hubs/pair/start (owner) -> `{code, expiresAt}`; 402 when the plan has no free hub slot
- POST /api/hubs/pair/complete (hub) `{code, hubPublicKey, edition, profile, version}` -> `{hubId}`. No token: the hub keeps an Ed25519 key and signs every later request (`X-Hub-Id`, `X-Hub-Timestamp`, `X-Hub-Signature`).
- POST /api/hubs/heartbeat (hub, signed) `{version, profile, updateChannel, health}` -> `{ok, updateChannel, remoteAccess}`
- GET /api/hubs -> `{hubs: [{id, name, edition, profile, version, updateChannel, remoteAccess, health: {ok, services}|null, lastSeen, createdAt}]}`
- PATCH /api/hubs/:id `{name?, updateChannel?, remoteAccess?}` -> `{hub}`; DELETE /api/hubs/:id -> `{ok}`
- GET /api/releases/latest?edition=mac|nvidia&channel=stable|beta -> `{edition, channel, version, manifestUrl, signatureUrl, signature, signatureScheme, namespace, sha256, releasedAt}`

Account (owner-only where noted)
- GET /api/account -> `{account: {id, createdAt}, members: [{id, email, role, status: "active"}], connectors: []}`. Connectors live on the Hub, so this is always an empty list.
- GET /api/account/export (owner) -> JSON of account, members, entitlement, hubs, orders, own passkey ids
- POST /api/account/delete (owner) `{confirm: "DELETE"}` -> `{ok}`. 409 `cancel_subscription_first` while the subscription is active. Removes users, sessions, passkeys, hubs, billing links; hardware order rows stay (accounting) without the shipping address; the audit chain is append-only and keeps only ids and keyed IP hashes.
- POST /api/account/members/invite -> 501 `not_implemented` (invitations are not built yet). There is no PATCH /api/account.

Static UI: every other GET is served from the `ASSETS` binding (portal/web build) with the same security headers.

Scheduled (hourly cron): prunes expired magic tokens, passkey challenges, sessions (expired or idle), hub pair codes, hub replay cache and hub rate counters, and seals any unsealed audit rows.
Support: proxy-free. The portal links to albena.ai/support.

## Rules
Stripe TEST mode only (sk_test via secret STRIPE_SECRET_KEY, whsec via STRIPE_WEBHOOK_SECRET); never store card data; prices from Stripe Price IDs in vars. Same security headers/CSP as site worker. Tests with vitest + @cloudflare/vitest-plugin. No deploys, no remote resources — lead integrates and deploys.
