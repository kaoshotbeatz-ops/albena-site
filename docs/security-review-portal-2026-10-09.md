Reviewed clean worktree `/Users/omarhuertas/Developer/portal-int`, branch `feat/portal-integrated`, commit `24b2867`. **11 findings**, most severe first. No files changed.

1. **High — Hub quota bypass through outstanding pairing codes**  
   [portal/worker/src/hubs/index.ts:109](portal/worker/src/hubs/index.ts:109)  
   **Exploit:** With zero hubs and a one-hub plan, request multiple pairing codes before redeeming any. Each redemption inserts another hub without checking entitlement or hub count. Codes also remain redeemable after cancellation. No concurrency is necessary.  
   **Fix:** Atomically validate current entitlement, enforce the account’s hub limit, consume the code, and insert the hub. Checking only `/pair/start` cannot enforce the limit.

2. **High — Invoice payment can reactivate a canceled subscription**  
   [portal/worker/src/billing/webhook.ts:66](portal/worker/src/billing/webhook.ts:66)  
   **Exploit:** Any newer `invoice.paid` for the customer sets their existing entitlement to `active`. The handler never verifies the invoice belongs to the entitlement’s subscription or that the subscription remains active. Paying an outstanding invoice after cancellation—or an unrelated invoice—can restore paid access and pairing privileges. Conversely, an unrelated failed invoice revokes access.  
   **Fix:** Resolve the invoice’s subscription, verify its customer/account association, and reconcile that subscription’s actual status. Never infer subscription status solely from an invoice event.

3. **High — Out-of-order entitlement protection is non-atomic**  
   [portal/worker/src/billing/entitlements.ts:38](portal/worker/src/billing/entitlements.ts:38)  
   **Trigger:** An older activation and newer cancellation both read the previous row. Cancellation writes first; activation then overwrites it because the UPSERT has no ordering predicate. Sequential events with identical second-resolution `created` timestamps also overwrite each other in delivery order.  
   **Fix:** Enforce ordering in the write itself, using an atomic conditional update/CAS. Serialize reconciliation per subscription and fetch authoritative state for ambiguous ordering. Do not merge patches from an unprotected stale read.

4. **High — Unpaid hardware orders become fulfillable**  
   [portal/worker/src/billing/webhook.ts:35](portal/worker/src/billing/webhook.ts:35)  
   **Exploit:** If delayed payment methods are enabled, an unpaid `checkout.session.completed` immediately creates a `pending_fulfillment` hardware order. The payment check below protects only entitlements. A payment that subsequently fails leaves the order fulfillable. Stripe explicitly distinguishes Checkout completion from delayed payment success. [Stripe fulfillment documentation](https://docs.stripe.com/checkout/fulfillment.md?payment-ui=stripe-hosted)  
   **Fix:** Store unpaid orders as awaiting payment; transition to fulfillment only after verified payment success. Handle asynchronous success/failure events and reconcile payment state before fulfillment.

5. **High — Account deletion can leave a billable subscription orphaned**  
   [portal/worker/src/account/index.ts:45](portal/worker/src/account/index.ts:45)  
   **Trigger:** A `past_due` or `incomplete` subscription makes `entitlement.active` false, so deletion succeeds and removes the billing association without canceling Stripe. `past_due` subscriptions can continue invoicing and retrying payments. The customer loses portal access while billing continues. [Stripe subscription lifecycle](https://docs.stripe.com/billing/subscriptions/overview)  
   **Fix:** Verify all subscriptions and pending Checkout sessions with Stripe before deletion. Require terminal cancellation or explicitly cancel and verify it before removing the association. Correct the client’s claim that deletion cancels subscriptions.

6. **Medium — Alternate Base64 encodings bypass hub replay protection**  
   [portal/worker/src/hubs/index.ts:62](portal/worker/src/hubs/index.ts:62), [crypto.ts:3](portal/worker/src/hubs/crypto.ts:3)  
   **Exploit:** Replay a captured signed heartbeat with Base64 padding removed or whitespace inserted into `X-Hub-Signature`. `atob()` decodes the same valid signature, but hashing the original header produces a different nonce key. This permits repeated stale heartbeat writes within the timestamp window.  
   **Fix:** Hash decoded signature bytes and reject noncanonical encodings. Canonicalize public keys before storing them as well.  
   **Verified:** An in-memory Ed25519 check accepted all three encodings and produced three distinct replay-cache keys.

7. **Medium — Customer Portal plan changes retain stale entitlements**  
   [portal/worker/src/billing/webhook.ts:18](portal/worker/src/billing/webhook.ts:18), [webhook.ts:58](portal/worker/src/billing/webhook.ts:58)  
   **Trigger:** The documented configuration permits Customer Portal plan changes, but the webhook derives the plan from original subscription metadata and prefers its interval over the actual recurring price. Changing the subscription’s price without changing metadata leaves the old plan and interval in the portal; a downgrade can preserve a higher hub allowance.  
   **Fix:** Derive plan and interval from an allowlisted mapping of current subscription price IDs. Treat metadata as attribution, not the authority for purchased features.

8. **Medium — Multiple Checkout sessions allow duplicate subscriptions**  
   [portal/worker/src/billing/index.ts:39](portal/worker/src/billing/index.ts:39)  
   **Trigger:** Open sessions for two different plans before completing either, then pay both. The active-entitlement check happens only when creating sessions. Idempotency keys vary by plan, interval, and five-minute bucket, so both sessions remain valid and create recurring subscriptions. A `past_due` customer can also start another subscription.  
   **Fix:** Maintain one account-level pending subscription purchase, reuse or expire outstanding sessions, and check existing nonterminal subscriptions. Reconcile unexpected duplicates instead of projecting all subscriptions into one entitlement row.

9. **Medium — Refund arriving before Checkout is permanently lost**  
   [portal/worker/src/billing/webhook.ts:78](portal/worker/src/billing/webhook.ts:78)  
   **Trigger:** Deliver `charge.refunded` before the corresponding Checkout event. The UPDATE matches no order, yet the event is marked processed. Checkout later inserts an unrefunded `pending_fulfillment` order; retrying the refund event is ignored as a duplicate.  
   **Fix:** Persist refund state independently of order existence, then reconcile it when creating the order. Alternatively, verify current payment/refund state before making an order fulfillable.

10. **Medium — Partial refunds cancel the entire hardware order**  
    [portal/worker/src/billing/webhook.ts:81](portal/worker/src/billing/webhook.ts:81)  
    **Trigger:** Any `charge.refunded` sets `refunded = 1` and cancels pending fulfillment, without checking the refunded amount. A small adjustment therefore cancels the whole order, despite the documented full-refund behavior. Stripe emits this event for partial refunds too. [Stripe event reference](https://docs.stripe.com/api/events/types#event_types-charge.refunded)  
    **Fix:** Track cumulative refund amounts and distinguish partial from full refunds. Apply an explicit allocation policy because the initial invoice includes hardware and subscription charges.

11. **Medium — Concurrent requests bypass pairing rate limits**  
    [portal/worker/src/hubs/index.ts:24](portal/worker/src/hubs/index.ts:24)  
    **Exploit:** Send concurrent pairing attempts from one IP. Requests can all read the same below-limit count and proceed. At window creation/reset, concurrent `INSERT OR REPLACE` calls also overwrite increments. Both the attempt and failure limits are affected.  
    **Fix:** Use an atomic conditional UPSERT with `RETURNING` to decide admission, or serialize counters through a Durable Object. Avoid separate read/check/increment operations.

Validation was source/schema/test inspection plus the in-memory signature reproduction; I did not run the Worker suite or live Stripe flows.