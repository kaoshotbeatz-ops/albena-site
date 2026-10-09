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
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`. Copy the signing secret (`whsec_...`).
5. **Secrets** (from `portal/worker`): `wrangler secret put STRIPE_SECRET_KEY` (an `sk_test_...` restricted key is best: write Customers, Checkout Sessions, Portal Sessions, Subscriptions (cancel on account deletion); read Invoices, Subscriptions, Checkout Sessions) and `wrangler secret put STRIPE_WEBHOOK_SECRET`.
6. **Vars** (`wrangler.jsonc` `vars`, ids not secrets):
   `PRICE_BYO_MONTHLY`, `PRICE_BYO_ANNUAL`, `PRICE_HUB_MAC_MONTHLY`, `PRICE_HUB_MAC_ANNUAL`, `PRICE_HUB_MAC_HARDWARE`,
   `PRICE_HUB_NVIDIA_MONTHLY`, `PRICE_HUB_NVIDIA_ANNUAL`, `PRICE_HUB_NVIDIA_HARDWARE`.  Empty values mean "not configured" (checkout answers 503). Return URLs use `PORTAL_ORIGIN`.
7. Apply the migration: `wrangler d1 migrations apply albena_portal` (lead merges migrations dir).
8. Local webhook testing: `stripe listen --forward-to localhost:8787/api/stripe/webhook` and use its `whsec_` locally. Test card `4242 4242 4242 4242`.

Going live later = swap to live keys, live price ids, re-create webhook in live mode.

## Behavior notes
- Hardware plans use one Checkout Session (mode `subscription`) with the recurring price plus a one-time price; Stripe bills the hardware on the first invoice. US shipping only.
- **Stripe is the source of truth.** Subscription and invoice events are only triggers: the handler fetches the subscription from the Stripe API and writes the entitlement from it. Plan and interval come from the allowlisted current price ids (`PRICE_*` vars), never from metadata (attribution only). Invoices that do not belong to the account's tracked subscription are ignored; an invoice never changes subscription state by itself. A second subscription never overwrites a tracked non-terminal one.
- **Ordering.** The entitlement write is one conditional UPSERT ordered by (event `created`, event id), so stale or concurrent deliveries cannot overwrite newer state. Events are also deduped in `stripe_events`; a handler failure returns 500 so Stripe retries.
- **Hardware orders** are created from the Checkout Session as Stripe reports it (hardware line identified by the `PRICE_*_HARDWARE` ids). Paid -> `pending_fulfillment`; delayed payment unpaid -> `awaiting_payment` until `checkout.session.async_payment_succeeded`, or `payment_failed` on `..._failed`. Only `pending_fulfillment` is fulfillable.
- **Refunds** are stored per charge (cumulative, max-merged) in `refunds`, independent of the order, and re-applied when the order is created or paid. Refunds are attributed to the hardware line first: cumulative refund >= hardware line total -> `refunded`, and an unshipped order becomes `cancelled_refunded`; anything less sets `refund_status='partially_refunded'` for manual review and cancels nothing.
- **Checkout** keeps one pending purchase per account (`checkout_pending`): the same plan reuses its open session, a different plan expires the old one first. Any non-terminal subscription at Stripe (active, trialing, past_due, unpaid, incomplete, paused) blocks a new checkout. The idempotency key is per pending purchase.
- **Account deletion** asks Stripe for non-terminal subscriptions and open Checkout sessions. If any exist it answers 409 `billing_active` (listing them) and deletes nothing, unless the request has `cancelBilling: true`: then they are cancelled/expired, re-read from Stripe to verify, and only then is the account deleted. A Stripe error fails closed (502).
- `getEntitlement(db, accountId).active` is true for `active`/`trialing`; `past_due` is reported but not active. `maxHubs` (see `plans.ts`) is 0 unless active. When an entitlement is not active, unused pairing codes are deleted, and `pair/complete` re-checks entitlement and hub count atomically.

## Tests
In the main suite (`portal/worker/test/billing.test.ts`), against real local D1 and the real app (auth, CSRF, audit).
