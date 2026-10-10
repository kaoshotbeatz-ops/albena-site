import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyEntitlement } from "../src/billing/entitlements";
import { prune } from "../src/cron";
import worker from "../src/index";
import { cloudflareMailer, devMailer, selectMailer, sendMail } from "../src/auth/mail";
import { now, IDLE_SECONDS } from "../src/auth/sessions";
import { auditSince, clearPortalTables, client, e, fakeStripe, lastAuditId, login, seedMember, seedOwner, testBindings } from "./helpers";

let env: ReturnType<typeof testBindings>;
beforeEach(async () => { env = testBindings(); await clearPortalTables(); });

describe("security endpoints", () => {
  it("lists and removes only the caller's passkeys", async () => {
    const a = await seedOwner("sa"), b = await seedOwner("sb");
    const ca = await login(a);
    for (const [id, u] of [["pk-a1", a], ["pk-a2", a], ["pk-b1", b]] as const)
      await e.DB.prepare("INSERT INTO passkeys (id,user_id,public_key,counter) VALUES (?,?,?,0)").bind(id, u.id, new Uint8Array([1])).run();
    const c = client(ca, env);
    const list = await (await c.request("/api/security/passkeys")).json() as any;
    expect(list.passkeys.map((p: any) => p.id).sort()).toEqual(["pk-a1", "pk-a2"]);
    expect(Object.keys(list.passkeys[0]).sort()).toEqual(["createdAt", "id"]); // never the public key
    expect((await c.request("/api/security/passkeys/pk-b1", { method: "DELETE" })).status).toBe(404);
    expect((await c.request("/api/security/passkeys/pk-a1", { method: "DELETE" })).status).toBe(200);
    // the last passkey may go: magic link always remains
    expect((await c.request("/api/security/passkeys/pk-a2", { method: "DELETE" })).status).toBe(200);
    expect((await e.DB.prepare("SELECT COUNT(*) n FROM passkeys WHERE user_id=?").bind(b.id).first<{ n: number }>())!.n).toBe(1);
    expect((await client(undefined, env).request("/api/security/passkeys")).status).toBe(401);
  });
  it("removing a passkey ends the user's other sessions but keeps the current one", async () => {
    const a = await seedOwner("ps-a"), b = await seedOwner("ps-b");
    const current = await login(a), other = await login(a), bystander = await login(b);
    await e.DB.prepare("INSERT INTO passkeys (id,user_id,public_key,counter) VALUES ('pk-ps',?,?,0)").bind(a.id, new Uint8Array([1])).run();
    expect((await client(other, env).request("/api/me")).status).toBe(200);
    expect((await client(current, env).request("/api/security/passkeys/pk-ps", { method: "DELETE" })).status).toBe(200);
    expect((await client(current, env).request("/api/me")).status).toBe(200);
    expect((await client(other, env).request("/api/me")).status).toBe(401);
    expect((await client(bystander, env).request("/api/me")).status).toBe(200);
    // a failed removal (not found) revokes nothing
    const third = await login(a);
    expect((await client(current, env).request("/api/security/passkeys/nope", { method: "DELETE" })).status).toBe(404);
    expect((await client(third, env).request("/api/me")).status).toBe(200);
  });
  it("sign-in history comes from the audit chain for this user only", async () => {
    const a = await seedOwner("ha"), b = await seedOwner("hb");
    const mk = (actor: string, action: string) => e.DB.prepare("INSERT INTO audit_log (actor,action,target,request_id) VALUES (?,?,?,?)").bind(actor, action, actor, "r").run();
    await mk(a.id, "auth.login.magic"); await mk(a.id, "auth.login.passkey"); await mk(a.id, "hub.update"); await mk(b.id, "auth.login.magic");
    const r = await (await client(await login(a), env).request("/api/security/history")).json() as any;
    expect(r.events.map((x: any) => x.method)).toEqual(["passkey", "magic_link"]);
    expect(Object.keys(r.events[0]).sort()).toEqual(["at", "method"]);
  });
});

describe("account", () => {
  it("returns account, members and no connectors", async () => {
    const o = await seedOwner("ao", "aacct"); await seedMember("am", "aacct");
    const r = await (await client(await login(o), env).request("/api/account")).json() as any;
    expect(r.account.id).toBe("aacct");
    expect(r.members).toEqual([{ id: "ao", email: "ao@example.com", role: "owner", status: "active" }, { id: "am", email: "am@example.com", role: "member", status: "active" }]);
    expect(r.connectors).toEqual([]);
  });
  it("export is owner-only and audited", async () => {
    const o = await seedOwner("xo", "xacct"), m = await seedMember("xm", "xacct");
    expect((await client(await login(m), env).request("/api/account/export")).status).toBe(403);
    const mark = await lastAuditId();
    const r = await client(await login(o), env).request("/api/account/export");
    expect(r.status).toBe(200);
    expect(Object.keys(await r.json() as object).sort()).toEqual(["account", "entitlement", "exportedAt", "hubs", "members", "orders", "passkeys"]);
    expect((await auditSince(mark)).map(a => a.action)).toContain("account.export");
  });
  it("delete requires owner, exact confirmation and no live subscription", async () => {
    const o = await seedOwner("do", "dacct"), m = await seedMember("dm", "dacct");
    const oc = await login(o);
    const del = (cookie: string, body: unknown) => client(cookie, env).request("/api/account/delete", { method: "POST", body: JSON.stringify(body) });
    expect((await del(await login(m), { confirm: "DELETE" })).status).toBe(403);
    expect((await del(oc, {})).status).toBe(400);
    expect((await del(oc, { confirm: "delete" })).status).toBe(400);
    await applyEntitlement(e.DB, "dacct", { plan: "byo", status: "active" }, 1);
    expect((await del(oc, { confirm: "DELETE" })).status).toBe(409); // no Stripe customer to prove it is closed
    expect(await e.DB.prepare("SELECT id FROM users WHERE id='do'").first()).not.toBeNull();
  });
  describe("[5] delete checks Stripe for anything that can still bill", () => {
    let fake: ReturnType<typeof fakeStripe>, oc: string;
    const del = (body: unknown) => client(oc, env).request("/api/account/delete", { method: "POST", body: JSON.stringify(body) });
    const alive = async () => !!(await e.DB.prepare("SELECT id FROM users WHERE id='bo'").first());
    beforeEach(async () => {
      fake = fakeStripe(); fake.install();
      oc = await login(await seedOwner("bo", "bacct"));
      await e.DB.prepare("INSERT INTO billing_customers VALUES ('bacct','cus_b',1)").run();
    });
    it("no billing objects: deletes", async () => {
      expect((await del({ confirm: "DELETE" })).status).toBe(200);
      expect(await alive()).toBe(false);
    });
    it.each(["past_due", "unpaid", "incomplete", "trialing", "active", "paused"])("a %s subscription refuses deletion with 409 and lists it", async (status) => {
      fake.subs.sub_b = { id: "sub_b", customer: "cus_b", status };
      const r = await del({ confirm: "DELETE" });
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ error: "billing_active", subscriptions: [{ id: "sub_b", status }], checkoutSessions: [] });
      expect(await alive()).toBe(true);
      expect(fake.calls.some((c) => c.method === "DELETE")).toBe(false);
    });
    it("terminal subscriptions do not block", async () => {
      fake.subs.sub_b = { id: "sub_b", customer: "cus_b", status: "canceled" };
      fake.subs.sub_c = { id: "sub_c", customer: "cus_b", status: "incomplete_expired" };
      expect((await del({ confirm: "DELETE" })).status).toBe(200);
    });
    it("an open checkout session refuses deletion", async () => {
      fake.sessions.cs_b = { id: "cs_b", customer: "cus_b", status: "open" };
      const r = await del({ confirm: "DELETE" });
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ error: "billing_active", checkoutSessions: ["cs_b"] });
      expect(await alive()).toBe(true);
    });
    it("cancelBilling cancels subscriptions, expires sessions, verifies, then deletes", async () => {
      fake.subs.sub_b = { id: "sub_b", customer: "cus_b", status: "past_due" };
      fake.sessions.cs_b = { id: "cs_b", customer: "cus_b", status: "open" };
      const mark = await lastAuditId();
      const r = await del({ confirm: "DELETE", cancelBilling: true });
      expect(r.status).toBe(200);
      expect(fake.subs.sub_b.status).toBe("canceled");
      expect(fake.sessions.cs_b.status).toBe("expired");
      expect(await alive()).toBe(false);
      expect((await auditSince(mark)).map((a) => a.action)).toEqual(expect.arrayContaining(["account.billing_canceled", "account.delete"]));
    });
    it("if cancellation cannot be verified, nothing is deleted", async () => {
      fake.subs.sub_b = { id: "sub_b", customer: "cus_b", status: "active" };
      const orig = globalThis.fetch;
      vi.stubGlobal("fetch", vi.fn(async (u: any, i: any) => (i?.method === "DELETE" ? new Response("{}", { status: 200 }) : orig(u, i)))); // Stripe "accepts" but state is unchanged
      const r = await del({ confirm: "DELETE", cancelBilling: true });
      expect(r.status).toBe(502);
      expect(await alive()).toBe(true);
    });
    it("a Stripe outage fails closed", async () => {
      fake.failPaths.add("/subscriptions");
      expect((await del({ confirm: "DELETE" })).status).toBe(502);
      expect(await alive()).toBe(true);
    });
  });
  it("delete removes the account and personal data but keeps the audit chain and order rows", async () => {
    fakeStripe().install(); // customer exists at Stripe with nothing open
    const o = await seedOwner("zo", "zacct"); await seedMember("zm", "zacct");
    const oc = await login(o);
    await e.DB.batch([
      e.DB.prepare("INSERT INTO passkeys (id,user_id,public_key,counter) VALUES ('pk-z','zo',?,0)").bind(new Uint8Array([1])),
      e.DB.prepare("INSERT INTO hubs (id,account_id,public_key,edition,profile,version,created_at) VALUES ('hz','zacct','k','mac','home','1.0.0',1)"),
      e.DB.prepare("INSERT INTO hub_nonces (hub_id,sig_hash,expires_at) VALUES ('hz','s',99999999999)"),
      e.DB.prepare("INSERT INTO billing_customers VALUES ('zacct','cus_z',1)"),
      e.DB.prepare("INSERT INTO hardware_orders (id,account_id,plan,checkout_session_id,shipping_json,created_at) VALUES ('hw_z','zacct','hub_mac','cs_z','{\"name\":\"Z\"}',1)"),
      e.DB.prepare("INSERT INTO magic_tokens (id,token_hash,browser_hash,email,expires_at) VALUES ('mt','a','b','zo@example.com',99999999999)"),
    ]);
    const mark = await lastAuditId();
    const r = await client(oc, env).request("/api/account/delete", { method: "POST", body: JSON.stringify({ confirm: "DELETE" }) });
    expect(r.status).toBe(200);
    expect(r.headers.getSetCookie().join(" ")).toMatch(/__Host-albena_session=;/);
    const n = async (sql: string) => (await e.DB.prepare(sql).first<{ n: number }>())!.n;
    expect(await n("SELECT COUNT(*) n FROM users WHERE id='zo'")).toBe(0);
    expect(await n("SELECT COUNT(*) n FROM accounts WHERE id='zacct'")).toBe(0);
    expect(await n("SELECT COUNT(*) n FROM members WHERE account_id='zacct'")).toBe(0);
    expect(await n("SELECT COUNT(*) n FROM sessions WHERE account_id='zacct'")).toBe(0);
    expect(await n("SELECT COUNT(*) n FROM passkeys WHERE user_id='zo'")).toBe(0);
    expect(await n("SELECT COUNT(*) n FROM hubs WHERE account_id='zacct'")).toBe(0);
    expect(await n("SELECT COUNT(*) n FROM hub_nonces WHERE hub_id='hz'")).toBe(0);
    expect(await n("SELECT COUNT(*) n FROM billing_customers WHERE account_id='zacct'")).toBe(0);
    expect(await n("SELECT COUNT(*) n FROM magic_tokens WHERE id='mt'")).toBe(0);
    expect(await e.DB.prepare("SELECT shipping_json FROM hardware_orders WHERE id='hw_z'").first()).toEqual({ shipping_json: null });
    expect(await e.DB.prepare("SELECT id FROM users WHERE id='zm'").first()).not.toBeNull(); // other member keeps their identity
    expect((await auditSince(mark)).map(a => a.action)).toContain("account.delete");
    expect((await client(oc, env).request("/api/me")).status).toBe(401);
  });
});

describe("scheduled prune", () => {
  it("deletes only expired rows", async () => {
    const o = await seedOwner("po"), t = now();
    const run = (sql: string, ...a: unknown[]) => e.DB.prepare(sql).bind(...a).run();
    await run("INSERT INTO magic_tokens (id,token_hash,browser_hash,email,expires_at) VALUES ('old','a','b','x@e.com',?),('new','a','b','y@e.com',?)", t - 1, t + 100);
    await run("INSERT INTO auth_challenges (id,challenge,kind,browser_hash,expires_at) VALUES ('co','c','login','b',?),('cn','c','login','b',?)", t - 1, t + 100);
    await run("INSERT INTO sessions (id,token_hash,user_id,account_id,created_at,last_seen,expires_at) VALUES ('s-exp','h1',?,?,1,?,?),('s-idle','h2',?,?,1,?,?),('s-ok','h3',?,?,1,?,?)",
      o.id, o.accountId, t, t - 1, o.id, o.accountId, t - IDLE_SECONDS - 1, t + 1000, o.id, o.accountId, t, t + 1000);
    await run("INSERT INTO hub_pair_codes (code_hash,account_id,user_id,expires_at,used_at,created_at) VALUES ('pc-old','a','u',?,NULL,1),('pc-live','a','u',?,NULL,1),('pc-used-old','a','u',?,?,1),('pc-used-new','a','u',?,?,1)",
      t - 90000, t + 100, t + 100, t - 90000, t + 100, t - 10);
    await run("INSERT INTO hub_nonces (hub_id,sig_hash,expires_at) VALUES ('h','old',?),('h','new',?)", t - 1, t + 100);
    await run("INSERT INTO hub_rate (bucket,window_start,count) VALUES ('old',?,1),('new',?,1)", t - 7200, t - 10);
    const counts = await prune(e, t);
    expect(counts).toEqual({ magicTokens: 1, authChallenges: 1, sessions: 2, hubPairCodes: 2, hubNonces: 1, hubRate: 1, hubMetrics: 0, hubModuleMetrics: 0 });
    const ids = async (sql: string) => (await e.DB.prepare(sql).all<{ i: string }>()).results.map(r => r.i).sort();
    expect(await ids("SELECT id i FROM magic_tokens")).toEqual(["new"]);
    expect(await ids("SELECT id i FROM sessions WHERE user_id='po'")).toEqual(["s-ok"]);
    expect(await ids("SELECT code_hash i FROM hub_pair_codes")).toEqual(["pc-live", "pc-used-new"]);
  });
  it("is wired as the worker's scheduled handler", async () => {
    expect(typeof worker.scheduled).toBe("function");
    await worker.scheduled!({ scheduledTime: Date.now(), cron: "23 * * * *", noRetry() {} } as unknown as ScheduledController, env);
  });
});

describe("mail providers", () => {
  const mail = { to: "user@example.com", url: "https://account.albena.ai/api/auth/magic/verify?token=SECRETTOKEN", code: "654321" };
  it("cloudflare provider sends text through the EMAIL binding", async () => {
    const send = vi.fn(async () => ({}));
    await cloudflareMailer({ ...env, MAIL_PROVIDER: "cloudflare", EMAIL: { send } as unknown as SendEmail }).send(mail);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "user@example.com", from: { email: "accounts@albena.ai", name: "Albena" }, subject: "Sign in to Albena", text: expect.stringContaining(mail.url) }));
  });
  it("cloudflare provider fails closed without the binding", async () => {
    await expect(cloudflareMailer({ ...env, EMAIL: undefined }).send(mail)).rejects.toThrow("mail_not_configured");
  });
  it("dev provider redacts in test, prints only in development, refuses production", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    await devMailer({ ...env, ENVIRONMENT: "test" }).send(mail);
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/SECRETTOKEN|654321/);
    await devMailer({ ...env, ENVIRONMENT: "development" }).send(mail);
    expect(log.mock.calls.flat().join(" ")).toContain("SECRETTOKEN");
    await expect(devMailer({ ...env, ENVIRONMENT: "production" }).send(mail)).rejects.toThrow("mail_not_configured");
    log.mockRestore();
  });
  it("selects by MAIL_PROVIDER and rejects unknown values (including the old mailchannels)", async () => {
    expect(() => selectMailer({ ...env, MAIL_PROVIDER: "mailchannels" as never })).toThrow("mail_not_configured");
    await expect(sendMail({ ...env, MAIL_PROVIDER: "dev", ENVIRONMENT: "production" }, mail)).rejects.toThrow();
  });
});

describe("static assets", () => {
  it("serves non-API GETs from ASSETS with security headers; unknown API paths stay JSON 404", async () => {
    const assets = { fetch: vi.fn(async () => new Response("<h1>ok</h1>", { headers: { "Content-Type": "text/html" } })) } as unknown as Fetcher;
    const c = client(undefined, { ...env, ASSETS: assets });
    const page = await c.request("/billing");
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    const api = await c.request("/api/nope");
    expect(api.status).toBe(404);
    expect(api.headers.get("content-type")).toContain("application/json");
    expect(assets.fetch).toHaveBeenCalledTimes(1);
  });
});
