import type { Context } from "hono";
import type { AppEnv } from "../types";
import { audit } from "../auth";
import { applyEntitlement } from "./entitlements";
import { verifyStripeSignature } from "./signature";

const now = () => Math.floor(Date.now() / 1000);

async function accountFor(db: D1Database, obj: any): Promise<string | null> {
  const direct = obj.client_reference_id ?? obj.metadata?.account_id ?? obj.subscription_details?.metadata?.account_id;
  if (direct) return direct;
  const cust = typeof obj.customer === "string" ? obj.customer : obj.customer?.id;
  if (!cust) return null;
  const r = await db.prepare("SELECT account_id FROM billing_customers WHERE stripe_customer_id = ?").bind(cust).first<{ account_id: string }>();
  return r?.account_id ?? null;
}

const intervalOf = (sub: any): string | null => {
  const i = sub.metadata?.interval ?? sub.items?.data?.[0]?.price?.recurring?.interval;
  return i === "month" ? "monthly" : i === "year" ? "annual" : (i ?? null);
};

/** Returns audit action name, or null if ignored. */
async function handle(db: D1Database, ev: any): Promise<{ action: string; target: string } | null> {
  const o = ev.data?.object ?? {};
  const created = ev.created ?? now();
  switch (ev.type) {
    case "checkout.session.completed": {
      const acct = await accountFor(db, o);
      if (!acct) return null;
      if (o.customer) {
        await db.prepare("INSERT OR IGNORE INTO billing_customers (account_id, stripe_customer_id, created_at) VALUES (?,?,?)").bind(acct, o.customer, now()).run();
      }
      const plan = o.metadata?.plan;
      if (o.metadata?.hardware === "1" && plan) {
        const ship = o.collected_information?.shipping_details ?? o.shipping_details ?? null;
        await db.prepare(
          `INSERT OR IGNORE INTO hardware_orders (id, account_id, plan, checkout_session_id, payment_intent, invoice, amount_total, currency, shipping_json, shipping_status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?, 'pending_fulfillment', ?)`,
        ).bind(`hw_${o.id}`, acct, plan, o.id, o.payment_intent ?? null, o.invoice ?? null, o.amount_total ?? null, o.currency ?? null, ship ? JSON.stringify(ship) : null, now()).run();
      }
      if (plan && o.mode === "subscription") {
        const paid = o.payment_status === "paid" || o.payment_status === "no_payment_required";
        await applyEntitlement(db, acct, {
          plan, status: paid ? "active" : "incomplete", billing_interval: o.metadata?.interval ?? null,
          stripe_subscription_id: typeof o.subscription === "string" ? o.subscription : (o.subscription?.id ?? null),
        }, created);
      }
      return { action: "billing.checkout_completed", target: acct };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const acct = await accountFor(db, o);
      if (!acct) return null;
      const deleted = ev.type.endsWith("deleted");
      const status = deleted ? "canceled" : o.status === "unpaid" ? "past_due" : o.status;
      await applyEntitlement(db, acct, {
        ...(o.metadata?.plan ? { plan: o.metadata.plan } : {}),
        status, billing_interval: intervalOf(o), stripe_subscription_id: o.id,
        current_period_end: o.current_period_end ?? o.items?.data?.[0]?.current_period_end ?? null,
        cancel_at_period_end: o.cancel_at_period_end ? 1 : 0,
      }, created);
      return { action: `billing.subscription_${ev.type.split(".").pop()}`, target: acct };
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const acct = await accountFor(db, o);
      if (!acct) return null;
      const paid = ev.type === "invoice.paid";
      const exists = await db.prepare("SELECT 1 AS x FROM entitlements WHERE account_id = ?").bind(acct).first();
      if (exists) {
        const end = o.lines?.data?.find((l: any) => l.period?.end)?.period?.end;
        await applyEntitlement(db, acct, { status: paid ? "active" : "past_due", ...(paid && end ? { current_period_end: end } : {}) }, created);
      }
      return { action: paid ? "billing.invoice_paid" : "billing.invoice_payment_failed", target: acct };
    }
    case "charge.refunded": {
      const pi = o.payment_intent ?? null, inv = o.invoice ?? null;
      const r = await db.prepare(
        `UPDATE hardware_orders SET refunded = 1, shipping_status = CASE WHEN shipping_status = 'pending_fulfillment' THEN 'cancelled_refunded' ELSE shipping_status END
         WHERE (? IS NOT NULL AND payment_intent = ?) OR (? IS NOT NULL AND invoice = ?)`,
      ).bind(pi, pi, inv, inv).run();
      return (r.meta?.changes ?? 0) > 0 ? { action: "billing.charge_refunded", target: String(o.id) } : null;
    }
    default:
      return null;
  }
}

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
    const prev = await db.prepare("SELECT status FROM stripe_events WHERE id = ?").bind(ev.id).first<{ status: string }>();
    if (prev?.status === "processed") return c.json({ received: true, duplicate: true });
    await db.prepare("UPDATE stripe_events SET status='processing' WHERE id = ?").bind(ev.id).run(); // retry of failed/stuck
  }
  try {
    const res = await handle(db, ev);
    await db.prepare("UPDATE stripe_events SET status='processed', processed_at=? WHERE id = ?").bind(now(), ev.id).run();
    if (res) await audit(c, res.action, res.target, { eventId: ev.id, type: ev.type });
    return c.json({ received: true });
  } catch (e) {
    await db.prepare("UPDATE stripe_events SET status='failed' WHERE id = ?").bind(ev.id).run();
    return c.json({ error: "handler_failed" }, 500); // Stripe retries
  }
}
