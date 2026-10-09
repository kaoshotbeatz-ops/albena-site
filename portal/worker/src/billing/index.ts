import type { Hono } from "hono";
import type { AppEnv, Bindings } from "../types";
import { audit, requireUser } from "../auth";
import { getEntitlement } from "./entitlements";
import { PLANS, isHardware, priceId, type Interval, type Plan } from "./plans";
import { stripe, StripeError } from "./stripe";
import { isNonTerminal } from "./reconcile";
import { stripeWebhook } from "./webhook";

export { getEntitlement } from "./entitlements";
export const migrations = ["0200_billing_init.sql", "0201_billing_hardening.sql"];

const base = (env: Bindings) => (env.PORTAL_ORIGIN).replace(/\/$/, "");

async function ensureCustomer(env: Bindings, accountId: string, email: string): Promise<string> {
  const row = await env.DB.prepare("SELECT stripe_customer_id FROM billing_customers WHERE account_id = ?").bind(accountId).first<{ stripe_customer_id: string }>();
  if (row) return row.stripe_customer_id;
  const cust = await stripe<{ id: string }>(env, "POST", "/customers", { email, metadata: { account_id: accountId } }, `albena-cust-${accountId}`);
  await env.DB.prepare("INSERT OR IGNORE INTO billing_customers (account_id, stripe_customer_id, created_at) VALUES (?,?,?)").bind(accountId, cust.id, Math.floor(Date.now() / 1000)).run();
  const again = await env.DB.prepare("SELECT stripe_customer_id FROM billing_customers WHERE account_id = ?").bind(accountId).first<{ stripe_customer_id: string }>();
  return again!.stripe_customer_id;
}

export function mount(app: Hono<AppEnv>): void {
  app.post("/api/stripe/webhook", stripeWebhook); // no session; authenticated by signature

  app.post("/api/billing/checkout", requireUser, async (c) => {
    const user = c.get("user");
    if (user.role !== "owner") return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json<{ plan?: string; interval?: string }>().catch(() => ({} as any));
    const plan = body.plan as Plan;
    const interval: Interval = body.interval === "annual" ? "annual" : "monthly";
    if (!PLANS.includes(plan)) return c.json({ error: "invalid_plan" }, 400);
    if (plan === "estate") return c.json({ error: "contact_sales", url: "https://albena.ai/contact" }, 400);

    const sub = priceId(c.env, plan, interval === "annual" ? "ANNUAL" : "MONTHLY");
    const hw = isHardware(plan) ? priceId(c.env, plan, "HARDWARE") : undefined;
    if (!sub || (isHardware(plan) && !hw)) return c.json({ error: "plan_not_configured" }, 503);

    const ent = await getEntitlement(c.env.DB, user.accountId);
    if (ent.active) return c.json({ error: "already_subscribed", hint: "use /api/billing/portal" }, 409);

    try {
      const customer = await ensureCustomer(c.env, user.accountId, user.email);
      // Stripe is the authority: any subscription that can still bill blocks a new purchase (past_due, incomplete, ...).
      const subs = await stripe<{ data: any[] }>(c.env, "GET", "/subscriptions", { customer, status: "all", limit: 100 });
      if (subs.data.some((s) => isNonTerminal(s.status))) return c.json({ error: "already_subscribed", hint: "use /api/billing/portal" }, 409);

      // One pending purchase per account: reuse the open session for the same plan, expire any other first.
      const t = Math.floor(Date.now() / 1000);
      const pend = await c.env.DB.prepare("SELECT * FROM checkout_pending WHERE account_id = ?").bind(user.accountId).first<any>();
      if (pend?.session_id) {
        const old = await stripe<any>(c.env, "GET", `/checkout/sessions/${pend.session_id}`).catch((e) => {
          if (e instanceof StripeError && e.status === 404) return { status: "expired" };
          throw e;
        });
        if (old.status === "complete") return c.json({ error: "checkout_in_progress" }, 409); // webhook has not landed yet
        if (old.status === "open") {
          if (pend.plan === plan && pend.interval === interval && old.url && pend.expires_at > t) return c.json({ url: old.url });
          await stripe(c.env, "POST", `/checkout/sessions/${pend.session_id}/expire`);
        }
      } else if (pend && t - pend.created_at < 120) {
        return c.json({ error: "checkout_in_progress" }, 409); // another request is creating the session right now
      }
      const pendingId = crypto.randomUUID();
      const expiresAt = t + 1860; // Stripe requires >= 30 minutes
      const claim = await c.env.DB.prepare(
        `INSERT INTO checkout_pending (account_id, pending_id, plan, interval, session_id, expires_at, created_at) VALUES (?,?,?,?,NULL,?,?)
         ON CONFLICT(account_id) DO UPDATE SET pending_id=excluded.pending_id, plan=excluded.plan, interval=excluded.interval, session_id=NULL,
           expires_at=excluded.expires_at, created_at=excluded.created_at
         WHERE checkout_pending.pending_id = ?`,
      ).bind(user.accountId, pendingId, plan, interval, expiresAt, t, pend?.pending_id ?? "").run();
      if (!(claim.meta?.changes ?? 0)) return c.json({ error: "checkout_in_progress" }, 409);

      const meta = { account_id: user.accountId, plan, interval, ...(hw ? { hardware: "1" } : {}) }; // attribution only
      let session: { id: string; url: string };
      try {
        session = await stripe<{ id: string; url: string }>(c.env, "POST", "/checkout/sessions", {
          mode: "subscription",
          customer,
          client_reference_id: user.accountId,
          line_items: [{ price: sub, quantity: 1 }, ...(hw ? [{ price: hw, quantity: 1 }] : [])],
          automatic_tax: { enabled: true },
          customer_update: { address: "auto", name: "auto", ...(hw ? { shipping: "auto" } : {}) },
          billing_address_collection: "required",
          tax_id_collection: { enabled: true },
          ...(hw ? { shipping_address_collection: { allowed_countries: ["US"] } } : {}),
          allow_promotion_codes: true,
          expires_at: expiresAt,
          metadata: meta,
          subscription_data: { metadata: meta },
          success_url: `${base(c.env)}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${base(c.env)}/billing?checkout=cancelled`,
        }, `albena-co-${user.accountId}-${pendingId}`); // one key per pending purchase: a retry of it cannot create a second session
      } catch (e) {
        await c.env.DB.prepare("DELETE FROM checkout_pending WHERE account_id = ? AND pending_id = ?").bind(user.accountId, pendingId).run();
        throw e;
      }
      await c.env.DB.prepare("UPDATE checkout_pending SET session_id = ? WHERE account_id = ? AND pending_id = ?").bind(session.id, user.accountId, pendingId).run();
      await audit(c, "billing.checkout_started", user.accountId, { plan, interval });
      return c.json({ url: session.url });
    } catch (e) {
      if (e instanceof StripeError) return c.json({ error: "stripe_error" }, 502);
      throw e;
    }
  });

  app.post("/api/billing/portal", requireUser, async (c) => {
    const user = c.get("user");
    if (user.role !== "owner") return c.json({ error: "forbidden" }, 403);
    const row = await c.env.DB.prepare("SELECT stripe_customer_id FROM billing_customers WHERE account_id = ?").bind(user.accountId).first<{ stripe_customer_id: string }>();
    if (!row) return c.json({ error: "no_billing_account" }, 404);
    try {
      const s = await stripe<{ url: string }>(c.env, "POST", "/billing_portal/sessions", { customer: row.stripe_customer_id, return_url: `${base(c.env)}/billing` });
      await audit(c, "billing.portal_opened", user.accountId);
      return c.json({ url: s.url });
    } catch (e) {
      if (e instanceof StripeError) return c.json({ error: "stripe_error" }, 502);
      throw e;
    }
  });

  app.get("/api/billing/summary", requireUser, async (c) => {
    const { accountId } = c.get("user");
    const entitlement = await getEntitlement(c.env.DB, accountId);
    const cust = await c.env.DB.prepare("SELECT 1 AS x FROM billing_customers WHERE account_id = ?").bind(accountId).first();
    return c.json({ entitlement, hasBillingAccount: !!cust });
  });

  app.get("/api/billing/orders", requireUser, async (c) => {
    const { accountId } = c.get("user");
    const { results } = await c.env.DB.prepare(
      "SELECT id, plan, shipping_status AS shippingStatus, refunded, refund_status AS refundStatus, amount_total AS amountTotal, currency, created_at AS createdAt FROM hardware_orders WHERE account_id = ? ORDER BY created_at DESC",
    ).bind(accountId).all<{ refunded: number }>();
    return c.json({ orders: results.map((o) => ({ ...o, refunded: !!o.refunded })) });
  });

  app.get("/api/billing/invoices", requireUser, async (c) => {
    const { accountId } = c.get("user");
    const row = await c.env.DB.prepare("SELECT stripe_customer_id FROM billing_customers WHERE account_id = ?").bind(accountId).first<{ stripe_customer_id: string }>();
    if (!row) return c.json({ invoices: [] });
    try {
      const r = await stripe<{ data: any[] }>(c.env, "GET", "/invoices", { customer: row.stripe_customer_id, limit: 24 });
      return c.json({
        invoices: r.data.map((i) => ({
          id: i.id, number: i.number ?? null, status: i.status, amountPaid: i.amount_paid, amountDue: i.amount_due,
          currency: i.currency, created: i.created, hostedInvoiceUrl: i.hosted_invoice_url ?? null, pdf: i.invoice_pdf ?? null,
        })),
      });
    } catch (e) {
      if (e instanceof StripeError) return c.json({ error: "stripe_error" }, 502);
      throw e;
    }
  });
}
