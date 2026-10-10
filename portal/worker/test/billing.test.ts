import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEntitlement } from "../src/billing";
import { verifyStripeSignature, hmacHex } from "../src/billing/signature";
import { applyEntitlement, writeManualEntitlement } from "../src/billing/entitlements";
import { WEBHOOK_SECRET as SECRET, fakeStripe, auditSince, clearPortalTables, client, e, lastAuditId, login, seedMember, seedOwner, testBindings } from "./helpers";

let fake: ReturnType<typeof fakeStripe>;
let db: D1Database, env: ReturnType<typeof testBindings>, app: ReturnType<typeof client>, ownerCookie: string, auditMark: number;
const auditEntries = { get: async () => auditSince(auditMark) };
const makeApp = (cookie?: string) => client(cookie, env);
async function sign(body: string, ts = Math.floor(Date.now() / 1000), secret = SECRET) {
  return `t=${ts},v1=${await hmacHex(secret, `${ts}.${body}`)}`;
}
async function postEvent(a: ReturnType<typeof client>, b: typeof env, ev: object, header?: string) {
  const body = JSON.stringify(ev);
  return a.request("/api/stripe/webhook", { method: "POST", body, headers: { "Stripe-Signature": header ?? (await sign(body)) } }, b);
}
beforeEach(async () => {
  db = e.DB; env = testBindings();
  fake = fakeStripe(); fake.install();
  await clearPortalTables();
  const owner = await seedOwner("u1", "acct_1");
  ownerCookie = await login(owner);
  app = makeApp(ownerCookie);
  auditMark = await lastAuditId();
});
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

// ---- Stripe fixtures: the fake API is the truth; webhook payloads are only triggers ----
const line = (price: string, total: number) => ({ price: { id: price }, amount_total: total });
const session = (o: any = {}) => ({
  id: "cs_1", status: "complete", mode: "subscription", customer: "cus_1", client_reference_id: "acct_1", subscription: "sub_1", payment_status: "paid",
  payment_intent: null, invoice: "in_1", amount_total: 99900, currency: "usd",
  line_items: { data: [line("price_mac_m", 9900), line("price_mac_hw", 90000)] },
  collected_information: { shipping_details: { name: "Omar", address: { country: "US" } } }, ...o,
});
const subscription = (o: any = {}) => ({
  id: "sub_1", customer: "cus_1", status: "active", current_period_end: 2000, cancel_at_period_end: false,
  metadata: { account_id: "acct_1", plan: "hub_mac" }, items: { data: [{ price: { id: "price_mac_m" } }] }, ...o,
});
const evCheckout = (o: any = {}, id = "evt_co", created = 100, type = "checkout.session.completed") => ({ id, type, created, data: { object: { id: "cs_1", mode: "subscription", customer: "cus_1", client_reference_id: "acct_1", subscription: "sub_1", ...o } } });
const evSub = (id: string, type: string, created: number, subId = "sub_1") => ({ id, type, created, data: { object: { id: subId, customer: "cus_1" } } });
const evInv = (id: string, type: string, created: number, o: any = {}) => ({ id, type, created, data: { object: { customer: "cus_1", subscription: "sub_1", ...o } } });
const evRefund = (id: string, created: number, o: any = {}) => ({ id, type: "charge.refunded", created, data: { object: { id: "ch_1", invoice: "in_1", amount: 99900, amount_refunded: 99900, ...o } } });
const seedStripe = () => { fake.subs.sub_1 = subscription(); fake.sessions.cs_1 = session(); };
const order = () => db.prepare("SELECT * FROM hardware_orders").first<any>();

describe("webhook processing", () => {
  beforeEach(seedStripe);
  it("duplicate event is applied once", async () => {
    expect((await (await postEvent(app, env, evCheckout())).json() as any).duplicate).toBeUndefined();
    const r2 = await (await postEvent(app, env, evCheckout())).json() as any;
    expect(r2.duplicate).toBe(true);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM hardware_orders").first<any>()).n).toBe(1);
    expect((await auditEntries.get()).filter((a) => a.action === "billing.checkout_completed")).toHaveLength(1);
  });
  it("failed handler returns 500 and is retried", async () => {
    const broken = testBindings({ DB: { prepare: (q: string) => { if (q.includes("hardware_orders")) throw new Error("boom"); return db.prepare(q); }, batch: (s: D1PreparedStatement[]) => db.batch(s) } as unknown as D1Database });
    expect((await postEvent(app, broken, evCheckout())).status).toBe(500);
    expect((await postEvent(app, env, evCheckout())).status).toBe(200);
    expect((await db.prepare("SELECT status FROM stripe_events WHERE id='evt_co'").first<any>()).status).toBe("processed");
  });
  it("a live 'processing' event is not taken over (409); a failed or stale (over 60s) one is", async () => {
    const row = () => db.prepare("SELECT status FROM stripe_events WHERE id='evt_co'").first<any>();
    await db.prepare("INSERT INTO stripe_events (id, type, status, received_at) VALUES ('evt_co','checkout.session.completed','processing',?)").bind(Math.floor(Date.now() / 1000) - 10).run();
    const busy = await postEvent(app, env, evCheckout());
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "event_in_progress" });
    expect((await row()).status).toBe("processing");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM hardware_orders").first<any>()).n).toBe(0);
    await db.prepare("UPDATE stripe_events SET received_at = ? WHERE id='evt_co'").bind(Math.floor(Date.now() / 1000) - 61).run();
    expect((await postEvent(app, env, evCheckout())).status).toBe(200);
    expect((await row()).status).toBe("processed");
    expect((await (await postEvent(app, env, evCheckout())).json() as any).duplicate).toBe(true);
  });
  it("checkout creates entitlement from the fetched subscription, customer map and a pending_fulfillment order", async () => {
    await postEvent(app, env, evCheckout());
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ plan: "hub_mac", status: "active", active: true, stripeSubscriptionId: "sub_1", billingInterval: "monthly", maxHubs: 1 });
    const o = await order();
    expect(o).toMatchObject({ shipping_status: "pending_fulfillment", hardware_amount: 90000, amount_total: 99900, plan: "hub_mac" });
    expect(JSON.parse(o.shipping_json).name).toBe("Omar");
    expect((await db.prepare("SELECT stripe_customer_id c FROM billing_customers").first<any>()).c).toBe("cus_1");
  });
  it("[2,7] transitions follow Stripe's subscription, not the event body", async () => {
    await postEvent(app, env, evCheckout());
    Object.assign(fake.subs.sub_1, { cancel_at_period_end: true, current_period_end: 3000 });
    await postEvent(app, env, evSub("e2", "customer.subscription.updated", 200));
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ status: "active", currentPeriodEnd: 3000, cancelAtPeriodEnd: true, billingInterval: "monthly" });
    fake.subs.sub_1.status = "past_due";
    await postEvent(app, env, evInv("e3", "invoice.payment_failed", 300));
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ status: "past_due", active: false });
    fake.subs.sub_1.status = "active"; fake.subs.sub_1.current_period_end = 5000;
    await postEvent(app, env, evInv("e4", "invoice.paid", 400));
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ status: "active", currentPeriodEnd: 5000 });
    fake.subs.sub_1.status = "canceled";
    await postEvent(app, env, evSub("e5", "customer.subscription.deleted", 500));
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ status: "canceled", active: false });
    fake.subs.sub_1.status = "active";
    await postEvent(app, env, evSub("e6", "customer.subscription.updated", 250)); // older than e5: ignored
    expect((await getEntitlement(db, "acct_1")).status).toBe("canceled");
  });
  it("[2] invoice.paid cannot reactivate a canceled subscription or act for an unrelated one", async () => {
    await postEvent(app, env, evCheckout());
    fake.subs.sub_1.status = "canceled";
    await postEvent(app, env, evSub("e2", "customer.subscription.deleted", 200));
    // a late payment of an old invoice: Stripe still says canceled
    await postEvent(app, env, evInv("e3", "invoice.paid", 300));
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ status: "canceled", active: false });
    // invoice for a subscription we do not track, and for another customer: no effect, no Stripe lookup needed
    fake.subs.sub_9 = subscription({ id: "sub_9" });
    await postEvent(app, env, evInv("e4", "invoice.paid", 400, { subscription: "sub_9" }));
    await postEvent(app, env, evInv("e5", "invoice.paid", 500, { customer: "cus_other" }));
    await postEvent(app, env, evInv("e6", "invoice.paid", 600, { subscription: null }));
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ status: "canceled", stripeSubscriptionId: "sub_1" });
    // an unrelated failed invoice cannot revoke an active entitlement either
    await db.prepare("DELETE FROM entitlements").run();
    fake.subs.sub_1.status = "active";
    await postEvent(app, env, evSub("e7", "customer.subscription.updated", 700));
    await postEvent(app, env, evInv("e8", "invoice.payment_failed", 800, { subscription: "sub_9" }));
    expect((await getEntitlement(db, "acct_1")).status).toBe("active");
  });
  it("[7] plan and interval come from the current price id, not metadata", async () => {
    await postEvent(app, env, evCheckout());
    fake.subs.sub_1.items = { data: [{ price: { id: "price_byo_a" } }] }; // portal downgrade; metadata still says hub_mac
    await postEvent(app, env, evSub("e2", "customer.subscription.updated", 200));
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ plan: "byo", billingInterval: "annual", maxHubs: 1, status: "active" });
    fake.subs.sub_1.items = { data: [{ price: { id: "price_unknown" } }] };
    await postEvent(app, env, evSub("e3", "customer.subscription.updated", 300));
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ plan: "none", active: false, maxHubs: 0 });
  });
  it("[3] older event never overwrites newer state; ties break on event id", async () => {
    expect(await applyEntitlement(db, "acct_1", { plan: "byo", status: "canceled" }, 200, "evt_b")).toBe(true);
    expect(await applyEntitlement(db, "acct_1", { plan: "byo", status: "active" }, 100, "evt_z")).toBe(false);
    expect(await applyEntitlement(db, "acct_1", { plan: "byo", status: "active" }, 200, "evt_a")).toBe(false); // same second, smaller id
    expect(await applyEntitlement(db, "acct_1", { plan: "byo", status: "active" }, 200, "evt_c")).toBe(true);
  });
  it("[3] concurrent writers converge on the newest event in either arrival order", async () => {
    for (const order of [[0, 1], [1, 0]]) {
      await db.prepare("DELETE FROM entitlements").run();
      const writes = [() => applyEntitlement(db, "acct_1", { plan: "byo", status: "active" }, 100, "e1"), () => applyEntitlement(db, "acct_1", { plan: "byo", status: "canceled" }, 200, "e2")];
      await Promise.all(order.map((i) => writes[i]()));
      expect((await getEntitlement(db, "acct_1")).status).toBe("canceled");
    }
  });
  it("[3,8] a second subscription never overwrites a tracked one; it is adopted once the first has ended", async () => {
    await postEvent(app, env, evCheckout());
    fake.subs.sub_2 = subscription({ id: "sub_2", items: { data: [{ price: { id: "price_byo_m" } }] } });
    await postEvent(app, env, evSub("e2", "customer.subscription.created", 200, "sub_2"));
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ stripeSubscriptionId: "sub_1", plan: "hub_mac" });
    fake.subs.sub_1.status = "canceled"; // the first one ends; the next event for sub_2 takes over
    await postEvent(app, env, evSub("e3", "customer.subscription.updated", 300, "sub_2"));
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ stripeSubscriptionId: "sub_2", plan: "byo", status: "active" });
  });
  it("[1] cancellation drops outstanding pairing codes", async () => {
    await postEvent(app, env, evCheckout());
    await db.prepare("INSERT INTO hub_pair_codes(code_hash,account_id,user_id,expires_at,created_at) VALUES('h','acct_1','u1',99999999999,1)").run();
    fake.subs.sub_1.status = "canceled";
    await postEvent(app, env, evSub("e2", "customer.subscription.deleted", 200));
    expect((await db.prepare("SELECT COUNT(*) n FROM hub_pair_codes").first<any>()).n).toBe(0);
  });
  it("[4] unpaid hardware order waits for payment; async success releases it, async failure kills it", async () => {
    fake.sessions.cs_1.payment_status = "unpaid"; fake.subs.sub_1.status = "incomplete";
    await postEvent(app, env, evCheckout());
    expect(await order()).toMatchObject({ shipping_status: "awaiting_payment" });
    expect((await getEntitlement(db, "acct_1")).active).toBe(false);
    fake.sessions.cs_1.payment_status = "paid"; fake.subs.sub_1.status = "active";
    await postEvent(app, env, evCheckout({}, "evt_ok", 200, "checkout.session.async_payment_succeeded"));
    expect(await order()).toMatchObject({ shipping_status: "pending_fulfillment" });
    expect((await getEntitlement(db, "acct_1")).active).toBe(true);
    // failure path on a second session
    fake.sessions.cs_2 = session({ id: "cs_2", payment_status: "unpaid", subscription: "sub_2", invoice: "in_2" });
    await postEvent(app, env, evCheckout({ id: "cs_2", subscription: "sub_2" }, "evt_co2", 300));
    await postEvent(app, env, evCheckout({ id: "cs_2", subscription: "sub_2" }, "evt_bad", 400, "checkout.session.async_payment_failed"));
    expect(await db.prepare("SELECT shipping_status s FROM hardware_orders WHERE id='hw_cs_2'").first()).toEqual({ s: "payment_failed" });
    // a late success event cannot resurrect a failed order unless Stripe says paid
    await postEvent(app, env, evCheckout({ id: "cs_2", subscription: "sub_2" }, "evt_late", 500, "checkout.session.async_payment_succeeded"));
    expect(await db.prepare("SELECT shipping_status s FROM hardware_orders WHERE id='hw_cs_2'").first()).toEqual({ s: "payment_failed" });
  });
  it("[10] partial refund is flagged, not cancelled; cumulative refunds reaching the hardware total cancel", async () => {
    await postEvent(app, env, evCheckout());
    await postEvent(app, env, evRefund("r1", 300, { amount_refunded: 5000 }));
    expect(await order()).toMatchObject({ refunded: 0, refund_status: "partially_refunded", refunded_amount: 5000, shipping_status: "pending_fulfillment" });
    await postEvent(app, env, evRefund("r2", 310, { amount_refunded: 2000 })); // stale, lower cumulative: never decreases
    expect(await order()).toMatchObject({ refunded_amount: 5000 });
    await postEvent(app, env, evRefund("r3", 320, { amount_refunded: 90000 }));
    expect(await order()).toMatchObject({ refunded: 1, refund_status: "refunded", shipping_status: "cancelled_refunded" });
  });
  it("[10] a refund smaller than the hardware line (e.g. subscription only) does not cancel the order", async () => {
    await postEvent(app, env, evCheckout());
    await postEvent(app, env, evRefund("r1", 300, { amount_refunded: 9900 }));
    expect(await order()).toMatchObject({ refunded: 0, refund_status: "partially_refunded", shipping_status: "pending_fulfillment" });
  });
  it("[10] a full refund leaves a shipped order's shipping status alone", async () => {
    await postEvent(app, env, evCheckout());
    await db.prepare("UPDATE hardware_orders SET shipping_status='shipped'").run();
    await postEvent(app, env, evRefund("r1", 300));
    expect(await order()).toMatchObject({ refunded: 1, refund_status: "refunded", shipping_status: "shipped" });
  });
  it("[9] a refund that arrives before the checkout is applied when the order is created", async () => {
    await postEvent(app, env, evRefund("r1", 50)); // no order yet
    expect(await db.prepare("SELECT amount_refunded a FROM refunds WHERE charge_id='ch_1'").first()).toEqual({ a: 99900 });
    await postEvent(app, env, evCheckout({}, "evt_co", 100));
    expect(await order()).toMatchObject({ refunded: 1, refund_status: "refunded", shipping_status: "cancelled_refunded" });
  });
  it("[9] a partial refund that arrives first is also applied", async () => {
    await postEvent(app, env, evRefund("r1", 50, { amount_refunded: 1000 }));
    await postEvent(app, env, evCheckout());
    expect(await order()).toMatchObject({ refunded: 0, refund_status: "partially_refunded", refunded_amount: 1000, shipping_status: "pending_fulfillment" });
  });
  it("non-hardware checkout creates no order; unknown event types are acknowledged", async () => {
    fake.sessions.cs_1.line_items = { data: [line("price_mac_m", 9900)] };
    await postEvent(app, env, evCheckout());
    expect((await db.prepare("SELECT COUNT(*) n FROM hardware_orders").first<any>()).n).toBe(0);
    expect((await postEvent(app, env, { id: "e8", type: "ping.x", data: { object: {} } })).status).toBe(200);
  });
  it("checkout for a customer that is not the account's own is ignored", async () => {
    await db.prepare("INSERT INTO billing_customers VALUES ('acct_1','cus_mine',1)").run();
    await postEvent(app, env, evCheckout()); // cus_1
    expect((await getEntitlement(db, "acct_1")).plan).toBe("none");
    expect((await db.prepare("SELECT COUNT(*) n FROM hardware_orders").first<any>()).n).toBe(0);
  });
});

describe("checkout", () => {
  const post = (a: any, body: any) => a.request("/api/billing/checkout", { method: "POST", body: JSON.stringify(body) });
  const creates = () => fake.calls.filter((c) => c.method === "POST" && c.path === "/checkout/sessions");

  it("byo monthly: subscription, tax, customer created, per-purchase idempotency, expiry", async () => {
    const r = await post(app, { plan: "byo", interval: "monthly" });
    expect(((await r.json()) as any).url).toMatch(/^https:\/\/checkout\.stripe\.com\/c\//);
    const c = creates()[0];
    const p = c.params;
    expect(p.get("mode")).toBe("subscription");
    expect(p.get("customer")).toBe("cus_new");
    expect(p.get("client_reference_id")).toBe("acct_1");
    expect(p.get("automatic_tax[enabled]")).toBe("true");
    expect(p.get("line_items[0][price]")).toBe("price_byo_m");
    expect(p.get("line_items[1][price]")).toBeNull();
    expect(p.get("shipping_address_collection[allowed_countries][0]")).toBeNull();
    expect(p.get("success_url")).toMatch(/^https:\/\/account\.albena\.ai\//);
    expect(Number(p.get("expires_at"))).toBeGreaterThan(Date.now() / 1000 + 1800);
    expect(c.key).toMatch(/^albena-co-acct_1-[0-9a-f-]{36}$/);
  });
  it("hardware: adds one-time price + US shipping; reuses customer", async () => {
    await db.prepare("INSERT INTO billing_customers VALUES ('acct_1','cus_old',1)").run();
    await post(app, { plan: "hub_nvidia", interval: "annual" });
    expect(fake.calls.some((c) => c.path === "/customers")).toBe(false);
    const p = creates()[0].params;
    expect(p.get("customer")).toBe("cus_old");
    expect(p.get("line_items[0][price]")).toBe("price_nv_a");
    expect(p.get("line_items[1][price]")).toBe("price_nv_hw");
    expect(p.get("shipping_address_collection[allowed_countries][0]")).toBe("US");
    expect(p.get("subscription_data[metadata][hardware]")).toBe("1");
  });
  it("estate -> contact sales; invalid plan 400; unconfigured 503; member 403; anon 401", async () => {
    const r = await post(app, { plan: "estate" });
    expect(r.status).toBe(400); expect((await r.json() as any).error).toBe("contact_sales");
    expect((await post(app, { plan: "zzz" })).status).toBe(400);
    expect(creates()).toHaveLength(0);
    const bare = { ...env, PRICE_BYO_MONTHLY: "" } as any;
    expect((await app.request("/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "byo" }) }, bare)).status).toBe(503);
    expect((await post(makeApp(await login(await seedMember("u2", "acct_1"))), { plan: "byo" })).status).toBe(403);
    expect((await post(makeApp(), { plan: "byo" })).status).toBe(401);
  });
  it("already-active account is told to use the portal", async () => {
    seedStripe();
    await postEvent(app, env, evCheckout());
    expect((await post(app, { plan: "byo" })).status).toBe(409);
  });
  it("[8] one pending purchase: the same plan reuses the open session, no second one is created", async () => {
    const u1 = ((await (await post(app, { plan: "byo", interval: "monthly" })).json()) as any).url;
    const u2 = ((await (await post(app, { plan: "byo", interval: "monthly" })).json()) as any).url;
    expect(u2).toBe(u1);
    expect(creates()).toHaveLength(1);
  });
  it("[8] a different plan expires the open session before creating the next", async () => {
    await post(app, { plan: "byo", interval: "monthly" });
    const r = await post(app, { plan: "hub_mac", interval: "annual" });
    expect(r.status).toBe(200);
    expect(creates()).toHaveLength(2);
    expect(fake.sessions.cs_new_1.status).toBe("expired");
    expect(fake.sessions.cs_new_2.status).toBe("open");
    expect((await db.prepare("SELECT session_id s, plan FROM checkout_pending").first<any>())).toEqual({ s: "cs_new_2", plan: "hub_mac" });
    expect(fake.calls.map((c) => c.path)).toContain("/checkout/sessions/cs_new_1/expire");
  });
  it("[8] concurrent requests create exactly one session", async () => {
    const rs = await Promise.all([post(app, { plan: "byo" }), post(app, { plan: "hub_mac" }), post(app, { plan: "byo" })]);
    expect(creates()).toHaveLength(1);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(2);
  });
  it("[8] any non-terminal subscription at Stripe blocks checkout; a canceled one does not", async () => {
    await db.prepare("INSERT INTO billing_customers VALUES ('acct_1','cus_1',1)").run();
    for (const status of ["past_due", "unpaid", "incomplete", "trialing", "active"]) {
      fake.subs.sub_x = subscription({ id: "sub_x", status });
      expect((await post(app, { plan: "byo" })).status).toBe(409);
    }
    expect(creates()).toHaveLength(0);
    fake.subs.sub_x.status = "canceled";
    expect((await post(app, { plan: "byo" })).status).toBe(200);
  });
  it("[8] a failed Stripe create releases the pending slot; completion and expiry clear it", async () => {
    fake.failPaths.add("/checkout/sessions");
    expect((await post(app, { plan: "byo" })).status).toBe(502);
    expect((await db.prepare("SELECT COUNT(*) n FROM checkout_pending").first<any>()).n).toBe(0);
    fake.failPaths.clear();
    await post(app, { plan: "byo" });
    await postEvent(app, env, { id: "evx", type: "checkout.session.expired", created: 5, data: { object: { id: "cs_new_1" } } });
    expect((await db.prepare("SELECT COUNT(*) n FROM checkout_pending").first<any>()).n).toBe(0);
  });
  it("[8] a stale half-created purchase (crash before session id) is taken over", async () => {
    await db.prepare("INSERT INTO checkout_pending VALUES ('acct_1','old','byo','monthly',NULL,1,1)").run();
    expect((await post(app, { plan: "byo" })).status).toBe(200);
    const now = Math.floor(Date.now() / 1000);
    await db.prepare("UPDATE checkout_pending SET session_id=NULL, created_at=?").bind(now).run();
    expect((await post(app, { plan: "byo" })).status).toBe(409); // someone is creating one right now
  });
  it("portal, summary, invoices", async () => {
    expect((await app.request("/api/billing/portal", { method: "POST" })).status).toBe(404);
    await db.prepare("INSERT INTO billing_customers VALUES ('acct_1','cus_1',1)").run();
    expect(await (await app.request("/api/billing/portal", { method: "POST" }, env)).json()).toEqual({ url: "https://billing.stripe.com/p/x" });
    expect(fake.calls.at(-1)!.params.get("customer")).toBe("cus_1");
    const inv = await (await app.request("/api/billing/invoices", {}, env)).json() as any;
    expect(inv.invoices[0]).toEqual({ id: "in_1", number: "A-1", status: "paid", amountPaid: 100, amountDue: 0, currency: "usd", created: 1, hostedInvoiceUrl: "h", pdf: "p" });
    const s = await (await app.request("/api/billing/summary", {}, env)).json() as any;
    expect(s.entitlement.plan).toBe("none"); expect(s.hasBillingAccount).toBe(true);
  });
});

describe("entitlement maxHubs", () => {
  it.each([["byo", 1], ["hub_mac", 1], ["hub_nvidia", 1], ["estate", 5]])("%s allows %i hub(s) while active", async (plan, n) => {
    await applyEntitlement(db, "acct_1", { plan, status: "active" }, 1);
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ plan, status: "active", active: true, maxHubs: n });
  });
  it("is 0 with no entitlement and when not active", async () => {
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ plan: "none", status: "none", active: false, maxHubs: 0 });
    await applyEntitlement(db, "acct_1", { plan: "estate", status: "past_due" }, 1);
    expect((await getEntitlement(db, "acct_1")).maxHubs).toBe(0);
  });
});

describe("orders", () => {
  it("lists only this account's hardware orders in camelCase", async () => {
    seedStripe();
    await postEvent(app, env, evCheckout());
    await db.prepare("INSERT INTO hardware_orders (id,account_id,plan,checkout_session_id,created_at) VALUES ('hw_other','acct_other','hub_mac','cs_o',1)").run();
    const r = await app.request("/api/billing/orders");
    expect(r.status).toBe(200);
    const { orders } = await r.json() as any;
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ id: "hw_cs_1", plan: "hub_mac", shippingStatus: "pending_fulfillment", refunded: false, refundStatus: "none", amountTotal: 99900, currency: "usd" });
    expect(orders[0].shipping_json).toBeUndefined();
    expect((await makeApp().request("/api/billing/orders")).status).toBe(401);
  });
  it("summary no longer embeds orders", async () => {
    const s = await (await app.request("/api/billing/summary")).json() as any;
    expect(Object.keys(s).sort()).toEqual(["entitlement", "hasBillingAccount"]);
    expect(s.entitlement.maxHubs).toBe(0);
  });
});

describe("manual grant vs Stripe precedence", () => {
  const manual = (over: Partial<Parameters<typeof writeManualEntitlement>[2]> = {}) =>
    writeManualEntitlement(db, "acct_1", { plan: "pilot", status: "active", endsAt: Math.floor(Date.now() / 1000) + 86400, note: "pilot for Dana", maxHubs: null, comp: false, ...over });
  const history = async () => (await db.prepare("SELECT kind, source, plan, status FROM entitlement_history WHERE account_id = 'acct_1' ORDER BY id").all<any>()).results;
  beforeEach(async () => {
    seedStripe();
    await db.prepare("INSERT INTO billing_customers VALUES ('acct_1','cus_1',1)").run();
    await db.prepare("DELETE FROM entitlement_history").run();
  });

  it("a manual grant is active with the pilot allowance of one hub and its end date", async () => {
    expect(await manual()).toBe(true);
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ plan: "pilot", status: "active", active: true, maxHubs: 1, source: "manual", comp: false });
  });
  it("Stripe events that are not an active subscription never touch a manual grant", async () => {
    await manual();
    for (const [i, status] of (["canceled", "past_due", "incomplete", "unpaid"] as const).entries()) {
      fake.subs.sub_1.status = status;
      await postEvent(app, env, evSub(`m${i}`, "customer.subscription.updated", 100 + i));
      expect(await getEntitlement(db, "acct_1")).toMatchObject({ plan: "pilot", status: "active", active: true, source: "manual" });
    }
    // unknown price (fail-closed "none") and a deleted subscription are equally ignored
    fake.subs.sub_1 = subscription({ items: { data: [{ price: { id: "price_unknown" } }] } });
    await postEvent(app, env, evSub("m10", "customer.subscription.updated", 200));
    delete fake.subs.sub_1;
    await postEvent(app, env, evSub("m11", "customer.subscription.deleted", 300));
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ plan: "pilot", status: "active", source: "manual" });
    expect(await history()).toEqual([]);
  });
  it("an active Stripe subscription wins and the manual grant is archived", async () => {
    await manual();
    await postEvent(app, env, evSub("w1", "customer.subscription.created", 100));
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ plan: "hub_mac", status: "active", source: "stripe", stripeSubscriptionId: "sub_1", endsAt: null, comp: false, maxHubs: 1 });
    expect(await history()).toEqual([{ kind: "archived_by_stripe", source: "manual", plan: "pilot", status: "active" }]);
    // once Stripe owns it, the ordinary Stripe rules apply again (cancel is honored)
    fake.subs.sub_1.status = "canceled";
    await postEvent(app, env, evSub("w2", "customer.subscription.deleted", 200));
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ status: "canceled", source: "stripe", active: false });
  });
  it("trialing also counts as a Stripe subscription becoming active", async () => {
    await manual({ plan: "byo" });
    fake.subs.sub_1.status = "trialing";
    await postEvent(app, env, evSub("w3", "customer.subscription.created", 100));
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ source: "stripe", status: "trialing", active: true });
  });
  it("a manual grant can be written again after Stripe ended, but not while a subscription can still bill", async () => {
    await postEvent(app, env, evCheckout());
    expect(await manual()).toBe(false); // live Stripe subscription
    expect((await getEntitlement(db, "acct_1")).source).toBe("stripe");
    fake.subs.sub_1.status = "canceled";
    await postEvent(app, env, evSub("c1", "customer.subscription.deleted", 500));
    expect(await manual({ plan: "comp", status: "active" })).toBe(true);
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ source: "manual", stripeSubscriptionId: null });
    // a late replay of the old, now-canceled subscription does not displace it
    await postEvent(app, env, evSub("c2", "customer.subscription.updated", 600));
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ source: "manual", status: "active" });
  });
  it("a manual grant lapses by its end date even before the cron runs", async () => {
    await manual({ endsAt: Math.floor(Date.now() / 1000) - 5 });
    expect(await getEntitlement(db, "acct_1")).toMatchObject({ status: "active", active: false, maxHubs: 0 });
  });
});
