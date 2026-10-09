import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditEntries } from "../src/_stubs";
import { getEntitlement } from "../src/billing";
import { verifyStripeSignature, hmacHex } from "../src/billing/signature";
import { ENV, SECRET, makeApp, makeD1, postEvent, sign } from "./billing-helpers";

let db: D1Database, env: ReturnType<typeof ENV>, app: ReturnType<typeof makeApp>;
beforeEach(() => { db = makeD1(); env = ENV(db); app = makeApp(); auditEntries.length = 0; });
afterEach(() => vi.unstubAllGlobals());

describe("signature", () => {
  const body = '{"id":"evt_1"}';
  it("accepts valid", async () => expect(await verifyStripeSignature(body, await sign(body), SECRET)).toBe(true));
  it("rejects wrong secret / tampered body / garbage", async () => {
    expect(await verifyStripeSignature(body, await sign(body, undefined, "other"), SECRET)).toBe(false);
    expect(await verifyStripeSignature(body + " ", await sign(body), SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, "nope", SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, null, SECRET)).toBe(false);
  });
  it("rejects old and far-future timestamps", async () => {
    const now = 1_800_000_000;
    expect(await verifyStripeSignature(body, await sign(body, now - 301), SECRET, now)).toBe(false);
    expect(await verifyStripeSignature(body, await sign(body, now + 301), SECRET, now)).toBe(false);
    expect(await verifyStripeSignature(body, await sign(body, now - 299), SECRET, now)).toBe(true);
  });
  it("accepts when any v1 matches (secret rotation)", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const good = await hmacHex(SECRET, `${ts}.${body}`);
    expect(await verifyStripeSignature(body, `t=${ts},v1=deadbeef,v1=${good}`, SECRET)).toBe(true);
  });
  it("webhook route returns 400 on bad signature and stores nothing", async () => {
    const r = await postEvent(app, env, { id: "evt_x", type: "invoice.paid", data: { object: {} } }, "t=1,v1=bad");
    expect(r.status).toBe(400);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM stripe_events").first<any>()).n).toBe(0);
  });
  it("replayed old-timestamp request is rejected", async () => {
    const body = JSON.stringify({ id: "evt_old", type: "invoice.paid", data: { object: {} } });
    const r = await app.request("/api/stripe/webhook", { method: "POST", body, headers: { "Stripe-Signature": await sign(body, Math.floor(Date.now() / 1000) - 3600) } }, env);
    expect(r.status).toBe(400);
  });
});

const sess = (o: any = {}) => ({ id: "evt_co", type: "checkout.session.completed", created: 100, data: { object: {
  id: "cs_1", mode: "subscription", customer: "cus_1", client_reference_id: "acct_1", subscription: "sub_1", payment_status: "paid",
  payment_intent: null, invoice: "in_1", amount_total: 99900, currency: "usd",
  metadata: { account_id: "acct_1", plan: "hub_mac", interval: "monthly", hardware: "1" },
  collected_information: { shipping_details: { name: "Omar", address: { country: "US" } } }, ...o } } });
const sub = (id: string, type: string, created: number, o: any = {}) => ({ id, type, created, data: { object: {
  id: "sub_1", customer: "cus_1", status: "active", current_period_end: 2000, cancel_at_period_end: false,
  metadata: { account_id: "acct_1", plan: "hub_mac" }, items: { data: [{ price: { recurring: { interval: "month" } } }] }, ...o } } });

describe("webhook processing", () => {
  it("duplicate event is applied once", async () => {
    expect((await (await postEvent(app, env, sess())).json() as any).duplicate).toBeUndefined();
    const r2 = await (await postEvent(app, env, sess())).json() as any;
    expect(r2.duplicate).toBe(true);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM hardware_orders").first<any>()).n).toBe(1);
    expect(auditEntries.filter((a) => a.action === "billing.checkout_completed")).toHaveLength(1);
  });
  it("failed handler returns 500 and is retried", async () => {
    const broken = ENV(db); const real = db.prepare.bind(db);
    (db as any).prepare = (q: string) => { if (q.includes("hardware_orders")) throw new Error("boom"); return real(q); };
    expect((await postEvent(app, broken, sess())).status).toBe(500);
    (db as any).prepare = real;
    expect((await postEvent(app, env, sess())).status).toBe(200);
    expect((await db.prepare("SELECT status FROM stripe_events WHERE id='evt_co'").first<any>()).status).toBe("processed");
  });
  it("checkout creates entitlement, customer map, hardware order pending_fulfillment", async () => {
    await postEvent(app, env, sess());
    const e = await getEntitlement(db, "acct_1");
    expect(e).toMatchObject({ plan: "hub_mac", status: "active", active: true, stripeSubscriptionId: "sub_1" });
    const o = await db.prepare("SELECT * FROM hardware_orders").first<any>();
    expect(o.shipping_status).toBe("pending_fulfillment");
    expect(JSON.parse(o.shipping_json).name).toBe("Omar");
    expect((await db.prepare("SELECT stripe_customer_id c FROM billing_customers").first<any>()).c).toBe("cus_1");
  });
  it("transitions: sub updated -> payment failed -> paid -> canceled; stale event ignored", async () => {
    await postEvent(app, env, sess());
    await postEvent(app, env, sub("e2", "customer.subscription.updated", 200, { cancel_at_period_end: true, current_period_end: 3000 }));
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ status: "active", currentPeriodEnd: 3000, cancelAtPeriodEnd: true, billingInterval: "monthly" });
    await postEvent(app, env, { id: "e3", type: "invoice.payment_failed", created: 300, data: { object: { customer: "cus_1" } } });
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ status: "past_due", active: false });
    await postEvent(app, env, { id: "e4", type: "invoice.paid", created: 400, data: { object: { customer: "cus_1", lines: { data: [{ period: { end: 5000 } }] } } } });
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ status: "active", currentPeriodEnd: 5000 });
    await postEvent(app, env, sub("e5", "customer.subscription.deleted", 500, { status: "canceled" }));
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ status: "canceled", active: false });
    await postEvent(app, env, sub("e6", "customer.subscription.updated", 250)); // older than e5
    expect((await getEntitlement(db, "acct_1")).status).toBe("canceled");
  });
  it("charge.refunded marks hardware order refunded/cancelled", async () => {
    await postEvent(app, env, sess());
    await postEvent(app, env, { id: "e7", type: "charge.refunded", created: 600, data: { object: { id: "ch_1", invoice: "in_1" } } });
    const o = await db.prepare("SELECT refunded, shipping_status FROM hardware_orders").first<any>();
    expect(o).toMatchObject({ refunded: 1, shipping_status: "cancelled_refunded" });
  });
  it("unknown event types are acknowledged", async () => {
    expect((await postEvent(app, env, { id: "e8", type: "ping.x", data: { object: {} } })).status).toBe(200);
  });
});

describe("checkout", () => {
  const mockStripe = () => {
    const calls: { url: string; init: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      const json = url.endsWith("/customers") ? { id: "cus_new" } : url.includes("/checkout/sessions") ? { url: "https://checkout.stripe.com/c/x" } : url.includes("billing_portal") ? { url: "https://billing.stripe.com/p/x" } : { data: [{ id: "in_1", number: "A-1", status: "paid", amount_paid: 100, amount_due: 0, currency: "usd", created: 1, hosted_invoice_url: "h", invoice_pdf: "p", secret: "x" }] };
      return new Response(JSON.stringify(json), { status: 200 });
    }));
    return calls;
  };
  const post = (a: any, body: any) => a.request("/api/billing/checkout", { method: "POST", body: JSON.stringify(body) }, env);

  it("byo monthly: subscription, tax, customer created, idempotency", async () => {
    const calls = mockStripe();
    const r = await post(app, { plan: "byo", interval: "monthly" });
    expect(await r.json()).toEqual({ url: "https://checkout.stripe.com/c/x" });
    const p = new URLSearchParams(calls[1].init.body);
    expect(p.get("mode")).toBe("subscription");
    expect(p.get("customer")).toBe("cus_new");
    expect(p.get("client_reference_id")).toBe("acct_1");
    expect(p.get("automatic_tax[enabled]")).toBe("true");
    expect(p.get("line_items[0][price]")).toBe("price_byo_m");
    expect(p.get("line_items[1][price]")).toBeNull();
    expect(p.get("shipping_address_collection[allowed_countries][0]")).toBeNull();
    expect(p.get("success_url")).toMatch(/^https:\/\/account\.albena\.ai\//);
    expect(calls[1].init.headers["Idempotency-Key"]).toMatch(/^albena-co-acct_1-byo-monthly-/);
    expect(calls[1].init.headers.Authorization).toBe("Bearer sk_test_x");
  });
  it("hardware: adds one-time price + US shipping; reuses customer", async () => {
    await db.prepare("INSERT INTO billing_customers VALUES ('acct_1','cus_old',1)").run();
    const calls = mockStripe();
    await post(app, { plan: "hub_nvidia", interval: "annual" });
    expect(calls).toHaveLength(1);
    const p = new URLSearchParams(calls[0].init.body);
    expect(p.get("customer")).toBe("cus_old");
    expect(p.get("line_items[0][price]")).toBe("price_nv_a");
    expect(p.get("line_items[1][price]")).toBe("price_nv_hw");
    expect(p.get("shipping_address_collection[allowed_countries][0]")).toBe("US");
    expect(p.get("subscription_data[metadata][hardware]")).toBe("1");
  });
  it("estate -> contact sales, no Stripe call; invalid plan 400; unconfigured 503; member 403; anon 401", async () => {
    const calls = mockStripe();
    const r = await post(app, { plan: "estate" });
    expect(r.status).toBe(400); expect((await r.json() as any).error).toBe("contact_sales");
    expect((await post(app, { plan: "zzz" })).status).toBe(400);
    expect((await post(app, { plan: "byo" }) ).status).toBe(200);
    const bare = { ...env, PRICE_BYO_MONTHLY: undefined } as any;
    expect((await app.request("/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "byo" }) }, bare)).status).toBe(503);
    expect((await post(makeApp({ id: "u2", email: "m@x.com", role: "member", accountId: "acct_1" }), { plan: "byo" })).status).toBe(403);
    expect((await post(makeApp(null), { plan: "byo" })).status).toBe(401);
    expect(calls.every((c) => !c.init.body?.includes("estate"))).toBe(true);
  });
  it("already-active account is told to use the portal", async () => {
    await postEvent(app, env, sess());
    mockStripe();
    expect((await post(app, { plan: "byo" })).status).toBe(409);
  });
  it("portal, summary, invoices", async () => {
    const calls = mockStripe();
    expect((await app.request("/api/billing/portal", { method: "POST" }, env)).status).toBe(404);
    await db.prepare("INSERT INTO billing_customers VALUES ('acct_1','cus_1',1)").run();
    expect(await (await app.request("/api/billing/portal", { method: "POST" }, env)).json()).toEqual({ url: "https://billing.stripe.com/p/x" });
    expect(new URLSearchParams(calls.at(-1)!.init.body).get("customer")).toBe("cus_1");
    const inv = await (await app.request("/api/billing/invoices", {}, env)).json() as any;
    expect(inv.invoices[0]).toEqual({ id: "in_1", number: "A-1", status: "paid", amountPaid: 100, amountDue: 0, currency: "usd", created: 1, hostedInvoiceUrl: "h", pdf: "p" });
    const s = await (await app.request("/api/billing/summary", {}, env)).json() as any;
    expect(s.entitlement.plan).toBe("none"); expect(s.hasBillingAccount).toBe(true);
  });
});
