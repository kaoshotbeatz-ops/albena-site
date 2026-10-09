# Billing (Stripe, TEST mode)

Module: `mount(app)` + `migrations` (`0200_billing_init.sql`) + `getEntitlement(db, accountId)` for the hubs module.
Routes: `POST /api/billing/checkout`, `POST /api/billing/portal`, `GET /api/billing/summary`, `GET /api/billing/orders`, `GET /api/billing/invoices`, `POST /api/stripe/webhook`.
Only Stripe customer/subscription/invoice ids are stored. No card data ever touches the Worker.

## Stripe dashboard setup (Omar, TEST mode toggle ON)
1. **Products and prices** (Product catalog). Create, and copy each `price_...` id:
   - Albena BYO: recurring monthly + recurring yearly.
   - Albena Hub (Mac): recurring monthly + yearly, plus a **one-time** price for the hardware.
   - Albena Hub (NVIDIA): recurring monthly + yearly, plus a **one-time** price for the hardware.
   - Estate is contact-sales: no price.
   Set a tax code on each product (software: SaaS/"General - Electronically Supplied Services"; hardware: "General - Tangible Goods").
2. **Tax**: Settings > Tax > enable Stripe Tax, add your head-office address and registrations. Checkout uses `automatic_tax`.
3. **Customer Portal**: Settings > Billing > Customer portal > activate. Allow: update payment method, view/download invoices, cancel subscription, switch plans (limit to the plans above). Set the default return URL to `https://account.albena.ai/billing`.
4. **Webhook**: Developers > Webhooks > Add endpoint `https://account.albena.ai/api/stripe/webhook`, events:
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`. Copy the signing secret (`whsec_...`).
5. **Secrets** (from `portal/worker`): `wrangler secret put STRIPE_SECRET_KEY` (an `sk_test_...` restricted key is best: write Customers, Checkout Sessions, Portal Sessions; read Invoices) and `wrangler secret put STRIPE_WEBHOOK_SECRET`.
6. **Vars** (`wrangler.jsonc` `vars`, ids not secrets):
   `PRICE_BYO_MONTHLY`, `PRICE_BYO_ANNUAL`, `PRICE_HUB_MAC_MONTHLY`, `PRICE_HUB_MAC_ANNUAL`, `PRICE_HUB_MAC_HARDWARE`,
   `PRICE_HUB_NVIDIA_MONTHLY`, `PRICE_HUB_NVIDIA_ANNUAL`, `PRICE_HUB_NVIDIA_HARDWARE`.  Empty values mean "not configured" (checkout answers 503). Return URLs use `PORTAL_ORIGIN`.
7. Apply the migration: `wrangler d1 migrations apply albena_portal` (lead merges migrations dir).
8. Local webhook testing: `stripe listen --forward-to localhost:8787/api/stripe/webhook` and use its `whsec_` locally. Test card `4242 4242 4242 4242`.

Going live later = swap to live keys, live price ids, re-create webhook in live mode.

## Behavior notes
- Hardware plans use one Checkout Session (mode `subscription`) with the recurring price plus a one-time price; Stripe bills the hardware on the first invoice. US shipping only. Order lands in `hardware_orders` with `shipping_status='pending_fulfillment'`; a full refund of a pending order flips it to `cancelled_refunded`.
- Webhooks: HMAC-SHA256 over `t.rawBody`, 300 s tolerance, constant-time compare, events deduped in `stripe_events`; handler failure returns 500 so Stripe retries. Out-of-order events are ignored via `last_event_created`.
- `getEntitlement(db, accountId).active` is true for `active`/`trialing`; `past_due` is reported but not active. `maxHubs` (see `plans.ts`) is 0 unless active.

## Tests
In the main suite (`portal/worker/test/billing.test.ts`), against real local D1 and the real app (auth, CSRF, audit).
