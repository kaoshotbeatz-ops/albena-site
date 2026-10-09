import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { app } from "../src/index";
import { VIEWAS_COOKIE } from "../src/auth/sessions";
import { auditSince, clearPortalTables, client, e, fakeStripe, lastAuditId, login, seedOwner, testBindings } from "./helpers";

const TEAM = "test-team.cloudflareaccess.com", AUD = "aud-test", ADMIN = "omar@example.com";
let keys: CryptoKeyPair, other: CryptoKeyPair;
const env = () => testBindings({ TEAM_DOMAIN: TEAM, ADMIN_AUD: AUD, SUPPORT_ADMIN_EMAILS: `${ADMIN}, other-admin@example.com` });

async function jwt(o: { email?: string; aud?: string; iss?: string; key?: CryptoKey } = {}) {
  return new SignJWT({ email: o.email ?? ADMIN }).setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(o.iss ?? `https://${TEAM}`).setAudience(o.aud ?? AUD).setIssuedAt().setExpirationTime("5m").sign(o.key ?? keys.privateKey);
}
const asAdmin = async (path: string, token?: string | null, b = env()) => app.request("https://account.albena.ai" + path,
  { headers: { ...(token === null ? {} : { "Cf-Access-Jwt-Assertion": token ?? await jwt() }) }, redirect: "manual" }, b);

beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  other = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) =>
    String(input).startsWith(`https://${TEAM}/cdn-cgi/access/certs`) ? new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Content-Type": "application/json" } }) : real(input, init)));
});
beforeEach(async () => { await clearPortalTables(); await e.DB.prepare("DELETE FROM sessions WHERE view_as = 1").run(); });

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

describe("Access gate", () => {
  it("denies a missing, invalid, wrong-audience, wrong-issuer or wrong-key token", async () => {
    await seedOwner("va-t1");
    for (const t of [null, "garbage", await jwt({ aud: "other" }), await jwt({ iss: "https://evil.example" }), await jwt({ key: other.privateKey })]) {
      expect((await asAdmin("/support/view-as?account=va-t1", t)).status).toBe(403);
      expect((await asAdmin("/api/support/accounts", t)).status).toBe(403);
      expect((await asAdmin("/support/customers", t)).status).toBe(403);
    }
  });
  it("denies a valid token whose email is not allowlisted, and everything when unconfigured", async () => {
    await seedOwner("va-t2");
    const t = await jwt({ email: "intruder@example.com" });
    expect((await asAdmin("/support/view-as?account=va-t2", t)).status).toBe(403);
    expect((await asAdmin("/api/support/accounts", await jwt(), testBindings())).status).toBe(403);
    expect((await asAdmin("/api/support/accounts", await jwt(), testBindings({ TEAM_DOMAIN: TEAM, ADMIN_AUD: AUD, SUPPORT_ADMIN_EMAILS: "" }))).status).toBe(403);
  });
  it("a customer session cannot reach /support or /api/support; the customer /support page stays public", async () => {
    const u = await seedOwner("va-t3");
    const c = client(await login(u), env());
    expect((await c.request("/support/view-as?account=va-t3")).status).toBe(403);
    expect((await c.request("/support/customers")).status).toBe(403);
    expect((await c.request("/api/support/accounts")).status).toBe(403);
    expect((await c.request("/api/support/other")).status).toBe(403);
    expect((await c.request("/support")).status).not.toBe(403);
  });
  it("lists accounts for an allowlisted admin", async () => {
    await seedOwner("va-t4");
    const res = await asAdmin("/api/support/accounts");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.me).toBe(ADMIN);
    const row = body.accounts.find((a: any) => a.id === "va-t4");
    expect(row).toMatchObject({ email: "va-t4@example.com", plan: "none", status: "none", hubs: 0 });
  });
});

describe("view-as session", () => {
  async function start(id: string) {
    const u = await seedOwner(id);
    const before = await lastAuditId();
    const res = await asAdmin(`/support/view-as?account=${id}`);
    expect(res.status).toBe(302);
    const sc = res.headers.get("set-cookie")!;
    expect(sc).toContain(VIEWAS_COOKIE);
    expect(sc).toMatch(/HttpOnly/i);
    return { u, before, cookie: cookieOf(res) };
  }

  it("starts a 30 minute read-only session, shown by /api/me, and audits it", async () => {
    const { u, before, cookie } = await start("va-s1");
    const row = (await e.DB.prepare("SELECT view_as, readonly, actor, expires_at - created_at AS ttl FROM sessions WHERE view_as = 1 AND account_id = ?").bind(u.accountId).first<any>())!;
    expect(row).toMatchObject({ view_as: 1, readonly: 1, actor: ADMIN, ttl: 1800 });
    const me = await (await client(cookie, env()).request("/api/me")).json() as any;
    expect(me.user.email).toBe(u.email);
    expect(me.viewAs.actor).toBe(ADMIN);
    expect(me.viewAs.expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(await auditSince(before)).toContainEqual({ action: "support.view_as.start", target: u.accountId });
    const actor = (await e.DB.prepare("SELECT actor FROM audit_log WHERE action = 'support.view_as.start' ORDER BY id DESC LIMIT 1").first<{ actor: string }>())!.actor;
    expect(actor).toBe(`support:${ADMIN}`);
  });
  it("404s an unknown account and does not set a cookie", async () => {
    const res = await asAdmin("/support/view-as?account=nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
  it("expires after 30 minutes", async () => {
    const { u, cookie } = await start("va-s2");
    const c = client(cookie, env());
    expect((await c.request("/api/me")).status).toBe(200);
    await e.DB.prepare("UPDATE sessions SET expires_at = unixepoch() - 1 WHERE view_as = 1 AND account_id = ?").bind(u.accountId).run();
    expect((await c.request("/api/me")).status).toBe(401);
  });
  it("is hidden from the customer's own session list and does not authenticate as a normal session", async () => {
    const { u, cookie } = await start("va-s3");
    const mine = await (await client(await login(u), env()).request("/api/security/sessions")).json() as any;
    expect(mine.sessions).toHaveLength(1);
    // The view-as token presented as the normal cookie must not work.
    const token = cookie.split("=")[1];
    expect((await client(`__Host-albena_session=${token}`, env()).request("/api/me")).status).toBe(401);
  });
  it("blocks every non-GET API route and the sensitive reads", async () => {
    const { u, cookie } = await start("va-s4");
    const f = fakeStripe(); f.install();
    const c = client(cookie, env());
    // Routes that never read a session cookie (login flow, machine auth, the exit endpoint) are exempt.
    // /api/support/* is Access-gated (a view-as cookie is not an Access token; see customerops.test.ts) and /api/invite/accept is the public invite redemption.
    const sessionless = /^\/api\/(stripe\/webhook|hubs\/(pair\/complete|heartbeat)|auth\/(magic\/|passkey\/login\/)|support\/|invite\/accept)/;
    const writes = app.routes.filter(r => r.method !== "GET" && r.method !== "ALL" && r.path.startsWith("/api/") && !sessionless.test(r.path));
    expect(writes.length).toBeGreaterThan(8);
    const before = await lastAuditId();
    for (const r of writes) {
      const res = await c.request(r.path.replace(/:\w+/g, "x"), { method: r.method, body: "{}" });
      expect([r.method, r.path, res.status, ((await res.json()) as any).error]).toEqual([r.method, r.path, 403, "read_only_support_view"]);
    }
    for (const p of ["/api/billing/invoices", "/api/account/export", "/api/security/passkeys", "/api/security/sessions", "/api/security/history"]) {
      const res = await c.request(p);
      expect([p, res.status, ((await res.json()) as any).error]).toEqual([p, 403, "read_only_support_view"]);
    }
    expect(f.calls.filter(x => x.path.startsWith("/billing_portal") || x.path === "/checkout/sessions" && x.method === "POST")).toHaveLength(0);
    const denied = (await auditSince(before)).filter(a => a.action === "support.view_as.denied_write");
    expect(denied.length).toBe(writes.length + 5);
    expect(denied.every(a => a.target === u.accountId)).toBe(true);
    // Reads the customer UI needs still work.
    for (const p of ["/api/me", "/api/account", "/api/billing/summary", "/api/billing/orders", "/api/hubs"]) expect([p, (await c.request(p)).status]).toEqual([p, 200]);
    // Nothing changed.
    expect((await e.DB.prepare("SELECT COUNT(*) n FROM accounts WHERE id = ?").bind(u.accountId).first<{ n: number }>())!.n).toBe(1);
  });
  it("exit ends the session, clears the cookie, audits, and works while read-only", async () => {
    const { u, cookie } = await start("va-s5");
    const before = await lastAuditId();
    const res = await client(cookie, env()).request("/api/support/view-as/end", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, redirect: "https://albena.ai/admin" });
    expect(res.headers.get("set-cookie")).toContain(`${VIEWAS_COOKIE}=;`);
    expect((await client(cookie, env()).request("/api/me")).status).toBe(401);
    expect(await auditSince(before)).toContainEqual({ action: "support.view_as.end", target: u.accountId });
  });
});

describe("normal sessions", () => {
  it("are unaffected: reads and writes work, no viewAs in /api/me", async () => {
    const u = await seedOwner("va-n1");
    const c = client(await login(u), env());
    const me = await (await c.request("/api/me")).json() as any;
    expect(me.viewAs).toBeUndefined();
    expect((await c.request("/api/account/export")).status).toBe(200);
    expect((await c.request("/api/security/sessions")).status).toBe(200);
    expect((await c.request("/api/hubs/pair/start", { method: "POST", body: "{}" })).status).not.toBe(403);
    expect((await c.request("/api/auth/logout", { method: "POST", body: "{}" })).status).toBe(200);
  });
});
