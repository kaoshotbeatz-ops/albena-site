import type { Hono } from "hono";
import type { AppEnv, Bindings } from "../_stubs";
import { audit, requireUser } from "../_stubs";
import { getEntitlement } from "./entitlements";
import { PLANS, isHardware, priceId, type Interval, type Plan } from "./plans";
import { stripe, StripeError } from "./stripe";
import { stripeWebhook } from "./webhook";

export { getEntitlement } from "./entitlements";
export const migrations = ["0200_billing_init.sql"];

const base = (env: Bindings) => (env.PORTAL_BASE_URL ?? "https://account.albena.ai").replace(/\/$/, "");

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
      const meta = { account_id: user.accountId, plan, interval, ...(hw ? { hardware: "1" } : {}) };
      const bucket = Math.floor(Date.now() / 300000); // same attempt within 5 min reuses the session
      const session = await stripe<{ url: string }>(c.env, "POST", "/checkout/sessions", {
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
        metadata: meta,
        subscription_data: { metadata: meta },
        success_url: `${base(c.env)}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base(c.env)}/billing?checkout=cancelled`,
      }, `albena-co-${user.accountId}-${plan}-${interval}-${bucket}`);
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
    const orders = await c.env.DB.prepare(
      "SELECT id, plan, shipping_status, refunded, amount_total, currency, created_at FROM hardware_orders WHERE account_id = ? ORDER BY created_at DESC",
    ).bind(accountId).all();
    const cust = await c.env.DB.prepare("SELECT 1 AS x FROM billing_customers WHERE account_id = ?").bind(accountId).first();
    return c.json({ entitlement, hasBillingAccount: !!cust, hardwareOrders: orders.results ?? [] });
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
