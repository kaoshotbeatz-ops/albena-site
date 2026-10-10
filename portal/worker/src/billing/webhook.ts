import type { Context } from "hono";
import type { AppEnv, Bindings } from "../types";
import { audit } from "../auth";
import { accountForCustomer, hardwareCatalog, reconcileSubscription } from "./reconcile";
import { stripe } from "./stripe";
import { verifyStripeSignature } from "./signature";

const now = () => Math.floor(Date.now() / 1000);

const idOf = (v: any): string | null => (typeof v === "string" ? v : v?.id ?? null);
const SESSION_ID = /^cs_[A-Za-z0-9_]+$/;
const FAR = 9007199254740991;
const FULL = `refunded_amount > 0 AND refunded_amount >= COALESCE(hardware_amount, amount_total, ${FAR})`;

/** Cumulative refunds (per charge, max-merged) that belong to an order, matched by payment intent or invoice. */
const REFUND_SUM = `(SELECT COALESCE(SUM(r.amount_refunded), 0) FROM refunds r WHERE (r.payment_intent IS NOT NULL AND r.payment_intent = hardware_orders.payment_intent) OR (r.invoice IS NOT NULL AND r.invoice = hardware_orders.invoice))`;

/**
 * Recomputes refund state for orders matching `where` from the refunds table (order independent).
 * Policy: refunds are attributed to the hardware line first. Refunded >= hardware line total => fully refunded
 * (an unshipped order is cancelled). Anything less is only flagged `partially_refunded` for a human to decide.
 */
async function applyRefunds(db: D1Database, where: string, ...args: unknown[]): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE hardware_orders SET refunded_amount = ${REFUND_SUM} WHERE ${where}`).bind(...args),
    db.prepare(
      `UPDATE hardware_orders SET
         refund_status = CASE WHEN refunded_amount <= 0 THEN 'none' WHEN ${FULL} THEN 'refunded' ELSE 'partially_refunded' END,
         refunded = CASE WHEN ${FULL} THEN 1 ELSE 0 END,
         shipping_status = CASE WHEN ${FULL} AND shipping_status IN ('pending_fulfillment','awaiting_payment') THEN 'cancelled_refunded' ELSE shipping_status END
       WHERE ${where}`,
    ).bind(...args),
  ]);
}

/** Creates/updates the hardware order for a Checkout Session from the session as Stripe reports it now. */
async function syncHardwareOrder(env: Bindings, sessionId: string, failed: boolean): Promise<string | null> {
  if (!SESSION_ID.test(sessionId)) return null;
  const db = env.DB;
  const s = await stripe<any>(env, "GET", `/checkout/sessions/${sessionId}`, { expand: ["line_items"] });
  const hw = hardwareCatalog(env);
  const line = (s.line_items?.data ?? []).find((l: any) => hw.has(l?.price?.id));
  if (!line) return null;
  const acct: string | undefined = s.client_reference_id ?? undefined;
  if (!acct) return null;
  const mapped = await accountForCustomer(db, idOf(s.customer));
  if (mapped && mapped !== acct) return null;
  const paid = s.payment_status === "paid" || s.payment_status === "no_payment_required";
  const ship = s.collected_information?.shipping_details ?? s.shipping_details ?? null;
  await db.prepare(
    `INSERT OR IGNORE INTO hardware_orders (id, account_id, plan, checkout_session_id, payment_intent, invoice, amount_total, hardware_amount, currency, shipping_json, shipping_status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(`hw_${s.id}`, acct, hw.get(line.price.id), s.id, idOf(s.payment_intent), idOf(s.invoice), s.amount_total ?? null, line.amount_total ?? null,
    s.currency ?? null, ship ? JSON.stringify(ship) : null, paid ? "pending_fulfillment" : "awaiting_payment", now()).run();
  if (paid) await db.prepare("UPDATE hardware_orders SET shipping_status='pending_fulfillment' WHERE checkout_session_id=? AND shipping_status='awaiting_payment'").bind(s.id).run();
  else if (failed) await db.prepare("UPDATE hardware_orders SET shipping_status='payment_failed' WHERE checkout_session_id=? AND shipping_status='awaiting_payment'").bind(s.id).run();
  // a refund may have been recorded before the order existed
  await applyRefunds(db, "checkout_session_id = ?", s.id);
  return acct;
}

type Handled = { action: string; target: string } | null;

/** Returns audit action name, or null if ignored. */
async function handle(env: Bindings, ev: any): Promise<Handled> {
  const db = env.DB;
  const o = ev.data?.object ?? {};
  const ord = { created: Number.isFinite(ev.created) ? ev.created : now(), id: String(ev.id) };
  switch (ev.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed": {
      const acct: string | undefined = o.client_reference_id;
      const customer = idOf(o.customer);
      if (!acct || !customer) return null;
      const have = await db.prepare("SELECT stripe_customer_id AS c FROM billing_customers WHERE account_id = ?").bind(acct).first<{ c: string }>();
      if (have && have.c !== customer) return null; // not the customer we created for this account
      if (!have) {
        await db.prepare("INSERT OR IGNORE INTO billing_customers (account_id, stripe_customer_id, created_at) VALUES (?,?,?)").bind(acct, customer, now()).run();
        if ((await accountForCustomer(db, customer)) !== acct) return null;
      }
      await db.prepare("DELETE FROM checkout_pending WHERE account_id = ? AND session_id = ?").bind(acct, o.id).run();
      const subId = idOf(o.subscription);
      if (o.mode === "subscription" && subId) await reconcileSubscription(env, subId, ord, acct);
      await syncHardwareOrder(env, o.id, ev.type.endsWith("async_payment_failed"));
      return { action: ev.type === "checkout.session.completed" ? "billing.checkout_completed" : `billing.${ev.type.split(".").pop()}`, target: acct };
    }
    case "checkout.session.expired": {
      await db.prepare("DELETE FROM checkout_pending WHERE session_id = ?").bind(o.id ?? "").run();
      return null;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      if (!o.id) return null;
      const r = await reconcileSubscription(env, o.id, ord);
      if (!r) return null;
      return { action: `billing.subscription_${ev.type.split(".").pop()}`, target: r.account };
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      // An invoice never decides subscription state. Only the tracked subscription's own invoices trigger a re-check.
      const subId = idOf(o.subscription) ?? idOf(o.parent?.subscription_details?.subscription);
      if (!subId) return null;
      const row = await db.prepare("SELECT account_id FROM entitlements WHERE stripe_subscription_id = ?").bind(subId).first<{ account_id: string }>();
      if (!row) return null;
      if ((await accountForCustomer(db, idOf(o.customer))) !== row.account_id) return null;
      const r = await reconcileSubscription(env, subId, ord, row.account_id);
      if (!r) return null;
      return { action: ev.type === "invoice.paid" ? "billing.invoice_paid" : "billing.invoice_payment_failed", target: r.account };
    }
    case "charge.refunded": {
      if (!o.id) return null;
      const pi = idOf(o.payment_intent), inv = idOf(o.invoice);
      const amt = Number.isFinite(o.amount_refunded) ? Number(o.amount_refunded) : 0;
      await db.prepare(
        `INSERT INTO refunds (charge_id, payment_intent, invoice, amount_refunded, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(charge_id) DO UPDATE SET amount_refunded = MAX(refunds.amount_refunded, excluded.amount_refunded),
           payment_intent = COALESCE(excluded.payment_intent, refunds.payment_intent), invoice = COALESCE(excluded.invoice, refunds.invoice), updated_at = excluded.updated_at`,
      ).bind(String(o.id), pi, inv, amt, now()).run();
      await applyRefunds(db, "(? IS NOT NULL AND payment_intent = ?) OR (? IS NOT NULL AND invoice = ?)", pi, pi, inv, inv);
      return { action: "billing.charge_refunded", target: String(o.id) };
    }
    default:
      return null;
  }
}

const RECLAIM_AFTER_S = 60;
export async function stripeWebhook(c: Context<AppEnv>): Promise<Response> {
  const raw = await c.req.text();
  const ok = await verifyStripeSignature(raw, c.req.header("Stripe-Signature"), c.env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return c.json({ error: "invalid_signature" }, 400);
  let ev: any;
  try { ev = JSON.parse(raw); } catch { return c.json({ error: "bad_json" }, 400); }
  if (!ev?.id || !ev?.type) return c.json({ error: "bad_event" }, 400);

  const db = c.env.DB;
  const ins = await db.prepare("INSERT OR IGNORE INTO stripe_events (id, type, status, received_at) VALUES (?,?, 'processing', ?)").bind(ev.id, ev.type, now()).run();
  if ((ins.meta?.changes ?? 0) === 0) {
    // Only a failed event, or one stuck in 'processing' for over a minute, may be taken over; a live concurrent delivery gets 409 (Stripe retries).
    const t = now();
    const taken = await db.prepare("UPDATE stripe_events SET status='processing', received_at=? WHERE id = ? AND (status='failed' OR (status='processing' AND received_at <= ?))")
      .bind(t, ev.id, t - RECLAIM_AFTER_S).run();
    if ((taken.meta?.changes ?? 0) === 0) {
      const prev = await db.prepare("SELECT status FROM stripe_events WHERE id = ?").bind(ev.id).first<{ status: string }>();
      if (prev?.status === "processed") return c.json({ received: true, duplicate: true });
      return c.json({ error: "event_in_progress" }, 409);
    }
  }
  try {
    const res = await handle(c.env, ev);
    await db.prepare("UPDATE stripe_events SET status='processed', processed_at=? WHERE id = ?").bind(now(), ev.id).run();
    if (res) await audit(c, res.action, res.target, { eventId: ev.id, type: ev.type });
    return c.json({ received: true });
  } catch (e) {
    await db.prepare("UPDATE stripe_events SET status='failed' WHERE id = ?").bind(ev.id).run();
    return c.json({ error: "handler_failed" }, 500); // Stripe retries
  }
}
