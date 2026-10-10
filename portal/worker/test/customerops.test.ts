import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { app } from "../src/index";
import { VIEWAS_COOKIE } from "../src/auth/sessions";
import { sha256 } from "../src/auth/crypto";
import { getEntitlement } from "../src/billing/entitlements";
import { expireManualGrants } from "../src/cron";
import { b64encode } from "../src/hubs/crypto";
import { ORIGIN, auditSince, clearPortalTables, client, e, lastAuditId, login, seedMember, seedOwner, testBindings } from "./helpers";

const TEAM = "test-team.cloudflareaccess.com", AUD = "aud-test", ADMIN = "omar@example.com";
let keys: CryptoKeyPair;
let mailbox: { to: string; subject?: string; text: string }[] = [];
const sendSpy = async (m: { to: string; subject?: string; text: string }) => { mailbox.push(m); return {}; };
const env = (over: Record<string, unknown> = {}) => testBindings({
  TEAM_DOMAIN: TEAM, ADMIN_AUD: AUD, SUPPORT_ADMIN_EMAILS: `${ADMIN}, second@example.com`,
  MAIL_PROVIDER: "cloudflare", EMAIL: { send: sendSpy } as unknown as SendEmail, ...over,
});
let ipN = 0;

async function jwt(email = ADMIN) {
  return new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`https://${TEAM}`).setAudience(AUD).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
}
/** A staff call: Cloudflare Access JWT plus the browser CSRF headers. */
async function staff(method: string, path: string, body?: unknown, email = ADMIN) {
  const res = await app.request(ORIGIN + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "X-Requested-With": "albena-portal", Origin: ORIGIN, "Cf-Access-Jwt-Assertion": await jwt(email), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
  }, env());
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
/** A public (no cookie) call such as invite acceptance or hub pairing. */
async function pub(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await app.request(ORIGIN + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "X-Requested-With": "albena-portal", Origin: ORIGIN, "cf-connecting-ip": `10.9.${Math.floor(ipN / 250)}.${ipN % 250}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extra },
  }, env());
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any, headers: res.headers };
}
const cookieOf = (res: { headers: Headers }, name: string) => (res.headers.get("set-cookie") ?? "").split(/,(?=\s*__Host)/).map((c) => c.trim().split(";")[0]).find((c) => c.startsWith(name + "="));
const last = (to?: string) => [...mailbox].reverse().find((m) => !to || m.to === to)!;
const inviteToken = (to: string) => new URL(last(to).text.match(/https:\/\/\S+/)![0]).searchParams.get("token")!;

beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    if (url.startsWith(`https://${TEAM}/cdn-cgi/access/certs`)) return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Content-Type": "application/json" } });
    if (url.includes("challenges.cloudflare.com")) return Response.json({ success: true, hostname: "account.albena.ai", action: "magic_login" });
    return real(input, init);
  }));
});
beforeEach(async () => {
  mailbox = []; ipN++;
  await clearPortalTables();
  await e.DB.batch(["entitlement_history", "invites", "reserved_hubs", "license_keys", "member_invites", "magic_tokens"].map((t) => e.DB.prepare(`DELETE FROM ${t}`)));
  await e.DB.prepare("DELETE FROM sessions WHERE view_as = 1").run();
});

async function keypair() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return b64encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey) as ArrayBuffer));
}
const pair = async (cred: Record<string, string>, edition = "mac") =>
  pub("POST", "/api/hubs/pair/complete", { ...cred, hubPublicKey: await keypair(), edition, profile: "home", version: "1.0.0" });
const hubCount = async (acct: string) => (await e.DB.prepare("SELECT COUNT(*) n FROM hubs WHERE account_id = ?").bind(acct).first<{ n: number }>())!.n;
const newCustomer = async (email: string, extra: Record<string, unknown> = {}) => (await staff("POST", "/api/support/accounts", { email, ...extra })).json.accountId as string;

/** Signs in through the real magic flow: browser cookie + the 6 digit code from the email. */
async function signInWithCode(res: { headers: Headers }, email: string) {
  const code = last(email).text.match(/Your code: (\d{3}) (\d{3})/)!.slice(1).join("");
  const cookie = cookieOf(res, "__Host-albena_magic")!;
  const r = await pub("POST", "/api/auth/magic/code", { code }, { Cookie: cookie });
  expect(r.status).toBe(200);
  return cookieOf(r, "__Host-albena_session")!;
}

describe("staff authorization", () => {
  const STAFF_ROUTES: [string, string][] = [
    ["GET", "/api/support/accounts"], ["GET", "/api/support/accounts/x"], ["POST", "/api/support/accounts"],
    ["POST", "/api/support/accounts/x/entitlement"], ["POST", "/api/support/accounts/x/notes"], ["POST", "/api/support/accounts/x/orders"],
    ["PATCH", "/api/support/orders/x"], ["POST", "/api/support/accounts/x/reserved-hubs"], ["DELETE", "/api/support/reserved-hubs/x"],
    ["POST", "/api/support/accounts/x/license-keys"], ["DELETE", "/api/support/license-keys/x"],
    ["GET", "/api/support/hubs/x"], ["GET", "/api/support/hubs/x/metrics"],
    ["GET", "/api/support/invites"], ["POST", "/api/support/invites"], ["POST", "/api/support/invites/bulk"], ["POST", "/api/support/invites/x/resend"], ["DELETE", "/api/support/invites/x"],
  ];
  it("every staff route is registered in this list (so a new one cannot skip the gate tests)", () => {
    const routes = app.routes.filter((r) => r.path.startsWith("/api/support/") && r.method !== "ALL" && r.path !== "/api/support/view-as/end")
      .map((r) => `${r.method} ${r.path.replace(/:\w+/g, "x")}`);
    expect([...new Set(routes)].sort()).toEqual(STAFF_ROUTES.map(([m, p]) => `${m} ${p}`).sort());
  });
  it("customers cannot reach any /api/support route", async () => {
    const u = await seedOwner("co-c1");
    const c = client(await login(u), env());
    for (const [m, p] of STAFF_ROUTES) expect([m, p, (await c.request(p, { method: m, body: m === "GET" ? undefined : "{}" })).status]).toEqual([m, p, 403]);
  });
  it("anonymous callers, and Access users outside the allowlist, are denied everywhere", async () => {
    const anon = client(undefined, env());
    for (const [m, p] of STAFF_ROUTES) expect([m, p, (await anon.request(p, { method: m, body: m === "GET" ? undefined : "{}" })).status]).toEqual([m, p, 403]);
    for (const [m, p] of STAFF_ROUTES) expect([m, p, (await staff(m, p, m === "GET" ? undefined : {}, "intruder@example.com")).status]).toEqual([m, p, 403]);
  });
  it("a read-only support view-as session cannot call staff endpoints", async () => {
    const u = await seedOwner("co-v1");
    const start = await app.request(ORIGIN + "/support/view-as?account=co-v1", { headers: { "Cf-Access-Jwt-Assertion": await jwt() }, redirect: "manual" }, env());
    const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie.startsWith(VIEWAS_COOKIE)).toBe(true);
    const c = client(cookie, env());
    const before = await lastAuditId();
    for (const [m, p] of STAFF_ROUTES) expect([m, p, (await c.request(p, { method: m, body: m === "GET" ? undefined : JSON.stringify({ email: "x@example.com", plan: "pilot" }) })).status]).toEqual([m, p, 403]);
    expect((await e.DB.prepare("SELECT COUNT(*) n FROM invites").first<{ n: number }>())!.n).toBe(0);
    expect((await e.DB.prepare("SELECT COUNT(*) n FROM entitlements WHERE account_id = ?").bind(u.accountId).first<{ n: number }>())!.n).toBe(0);
    expect((await auditSince(before)).some((a) => a.action.startsWith("support.invite") || a.action.startsWith("support.entitlement"))).toBe(false);
  });
  it("staff writes are audited under support:<email> and hash-chained", async () => {
    const before = await lastAuditId();
    const id = await newCustomer("audit-me@example.com", { plan: "pilot" });
    const rows = (await e.DB.prepare("SELECT actor, action, target, hash FROM audit_log WHERE id > ? ORDER BY id").bind(before).all<any>()).results;
    expect(rows.map((r) => r.action)).toEqual(["support.account.create", "support.entitlement.grant"]);
    expect(rows.every((r) => r.actor === `support:${ADMIN}` && r.target === id && /^[a-f0-9]{64}$/.test(r.hash))).toBe(true);
    await staff("POST", `/api/support/accounts/${id}/notes`, { body: "hello" }, "second@example.com");
    expect((await e.DB.prepare("SELECT actor FROM audit_log WHERE action = 'support.note.add' ORDER BY id DESC LIMIT 1").first<{ actor: string }>())!.actor).toBe("support:second@example.com");
  });
});

describe("manual customers", () => {
  it("creates user + owner account without a login, and the person signs in later with that email", async () => {
    const r = await staff("POST", "/api/support/accounts", { email: "  Dana@Example.com ", name: "Dana", plan: "hub_mac" });
    expect(r.status).toBe(201);
    const id = r.json.accountId;
    expect(await e.DB.prepare("SELECT email, name FROM users WHERE id = ?").bind(id).first()).toEqual({ email: "dana@example.com", name: "Dana" });
    expect(await e.DB.prepare("SELECT role FROM members WHERE account_id = ? AND user_id = ?").bind(id, id).first()).toEqual({ role: "owner" });
    expect((await e.DB.prepare("SELECT COUNT(*) n FROM sessions WHERE user_id = ?").bind(id).first<any>()).n).toBe(0);
    expect(await getEntitlement(e.DB, id)).toMatchObject({ plan: "hub_mac", active: true, source: "manual", maxHubs: 1 });
    // later: normal magic sign-in lands in the same account with the entitlement
    const start = await pub("POST", "/api/auth/magic/start", { email: "dana@example.com", turnstileToken: "t" });
    expect(start.status).toBe(202);
    const session = await signInWithCode(start, "dana@example.com");
    const me = await (await client(session, env()).request("/api/me")).json() as any;
    expect(me.user).toMatchObject({ id, accountId: id, role: "owner" });
    const sum = await (await client(session, env()).request("/api/billing/summary")).json() as any;
    expect(sum.entitlement).toMatchObject({ plan: "hub_mac", active: true, source: "manual" });
  });
  it("rejects duplicates, bad emails and an unknown plan; creating without a plan leaves no entitlement", async () => {
    const id = await newCustomer("dup@example.com");
    expect(await getEntitlement(e.DB, id)).toMatchObject({ plan: "none", active: false });
    expect(await staff("POST", "/api/support/accounts", { email: "dup@example.com" })).toMatchObject({ status: 409, json: { error: "exists", accountId: id } });
    expect((await staff("POST", "/api/support/accounts", { email: "not-an-email" })).status).toBe(400);
    const bad = await staff("POST", "/api/support/accounts", { email: "badplan@example.com", plan: "platinum" });
    expect(bad.status).toBe(400);
  });
});

describe("plans by hand", () => {
  it("pilot: 30 day default, one Hub, history recorded", async () => {
    const id = await newCustomer("pilot@example.com");
    const r = await staff("POST", `/api/support/accounts/${id}/entitlement`, { plan: "pilot", note: "Dana pilot" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ kind: "grant", entitlement: { plan: "pilot", status: "active", active: true, maxHubs: 1, source: "manual" } });
    const ends = r.json.entitlement.endsAt, t = Math.floor(Date.now() / 1000);
    expect(ends).toBeGreaterThan(t + 29 * 86400); expect(ends).toBeLessThanOrEqual(t + 30 * 86400 + 5);
    expect(await e.DB.prepare("SELECT kind, source, plan, status, actor FROM entitlement_history WHERE account_id = ?").bind(id).first()).toEqual({ kind: "grant", source: "manual", plan: "pilot", status: "active", actor: `support:${ADMIN}` });
  });
  it("maxHubs is configurable per grant and enforced when pairing", async () => {
    const id = await newCustomer("two@example.com");
    await staff("POST", `/api/support/accounts/${id}/entitlement`, { plan: "pilot", maxHubs: 2, days: 10 });
    const owner = await login({ id, email: "two@example.com", accountId: id, role: "owner" });
    const code = async () => ((await (await client(owner, env()).request("/api/hubs/pair/start", { method: "POST" })).json()) as any).code;
    expect((await pair({ code: await code() })).status).toBe(200);
    expect((await pair({ code: await code() })).status).toBe(200);
    expect((await client(owner, env()).request("/api/hubs/pair/start", { method: "POST" })).status).toBe(402);
    expect(await hubCount(id)).toBe(2);
    expect((await staff("POST", `/api/support/accounts/${id}/entitlement`, { plan: "pilot", maxHubs: 0 })).json.error).toBe("invalid_max_hubs");
  });
  it("comp mirrors the chosen plan and needs basePlan; plain plans can run open-ended", async () => {
    const id = await newCustomer("comp@example.com");
    expect((await staff("POST", `/api/support/accounts/${id}/entitlement`, { plan: "comp" })).json.error).toBe("base_plan_required");
    const r = await staff("POST", `/api/support/accounts/${id}/entitlement`, { plan: "comp", basePlan: "estate" });
    expect(r.json.entitlement).toMatchObject({ plan: "estate", comp: true, maxHubs: 5, endsAt: null, active: true });
    const plain = await staff("POST", `/api/support/accounts/${id}/entitlement`, { plan: "byo" });
    expect(plain.json.entitlement).toMatchObject({ plan: "byo", comp: false, maxHubs: 1 });
  });
  it("suspend, reactivate and extend keep the plan; suspending drops pair codes and blocks pairing", async () => {
    const id = await newCustomer("susp@example.com", { plan: "hub_nvidia", days: 40 });
    const owner = await login({ id, email: "susp@example.com", accountId: id, role: "owner" });
    const start = await (await client(owner, env()).request("/api/hubs/pair/start", { method: "POST" })).json() as any;
    const s = await staff("POST", `/api/support/accounts/${id}/entitlement`, { status: "suspended", note: "chargeback talk" });
    expect(s.json).toMatchObject({ kind: "suspend", entitlement: { plan: "hub_nvidia", status: "suspended", active: false, maxHubs: 0 } });
    expect((await e.DB.prepare("SELECT COUNT(*) n FROM hub_pair_codes WHERE account_id = ?").bind(id).first<any>()).n).toBe(0);
    expect((await pair({ code: start.code })).status).toBe(400);
    const r = await staff("POST", `/api/support/accounts/${id}/entitlement`, { status: "active" });
    expect(r.json).toMatchObject({ kind: "reactivate", entitlement: { plan: "hub_nvidia", active: true } });
    expect(r.json.entitlement.endsAt).toBeGreaterThan(Date.now() / 1000 + 39 * 86400); // end date kept
    const x = await staff("POST", `/api/support/accounts/${id}/entitlement`, { days: 90 });
    expect(x.json.kind).toBe("extend");
    expect(x.json.entitlement.endsAt).toBeGreaterThan(Date.now() / 1000 + 89 * 86400);
    const kinds = (await e.DB.prepare("SELECT kind FROM entitlement_history WHERE account_id = ? ORDER BY id").bind(id).all<any>()).results.map((h) => h.kind);
    expect(kinds).toEqual(["grant", "suspend", "reactivate", "extend"]);
  });
  it("validates input: plan required, past end dates, bad status, unknown account", async () => {
    const id = await newCustomer("val@example.com");
    const post = (b: unknown) => staff("POST", `/api/support/accounts/${id}/entitlement`, b);
    expect((await post({})).json.error).toBe("plan_required");
    expect((await post({ status: "suspended" })).json.error).toBe("plan_required");
    expect((await post({ plan: "byo", ends_at: 5 })).json.error).toBe("ends_at_in_past");
    expect((await post({ plan: "byo", status: "weird" })).json.error).toBe("invalid_status");
    expect((await post({ plan: "byo", days: 0 })).json.error).toBe("invalid_days");
    expect((await staff("POST", "/api/support/accounts/nope/entitlement", { plan: "byo" })).status).toBe(404);
    expect(await getEntitlement(e.DB, id)).toMatchObject({ plan: "none" });
  });
  it("staff cannot overwrite a live Stripe subscription", async () => {
    const id = await newCustomer("stripe@example.com");
    await e.DB.prepare("INSERT INTO entitlements (account_id, plan, status, stripe_subscription_id, updated_at, source) VALUES (?, 'hub_mac', 'active', 'sub_9', 1, 'stripe')").bind(id).run();
    const r = await staff("POST", `/api/support/accounts/${id}/entitlement`, { plan: "pilot" });
    expect(r).toMatchObject({ status: 409, json: { error: "stripe_subscription_active" } });
    expect(await getEntitlement(e.DB, id)).toMatchObject({ plan: "hub_mac", source: "stripe", stripeSubscriptionId: "sub_9" });
    await e.DB.prepare("UPDATE entitlements SET status = 'canceled' WHERE account_id = ?").bind(id).run();
    expect((await staff("POST", `/api/support/accounts/${id}/entitlement`, { plan: "pilot" })).status).toBe(200);
  });
});

describe("pilot expiry cron", () => {
  it("flips expired manual grants to inactive, drops pair codes, records history and audit; leaves the rest", async () => {
    const a = await newCustomer("exp-a@example.com", { plan: "pilot", days: 5 });
    const b = await newCustomer("exp-b@example.com", { plan: "pilot", days: 5 });
    const c = await newCustomer("exp-c@example.com", { plan: "hub_mac" }); // open-ended
    const ownerA = await login({ id: a, email: "exp-a@example.com", accountId: a, role: "owner" });
    const code = ((await (await client(ownerA, env()).request("/api/hubs/pair/start", { method: "POST" })).json()) as any).code;
    await e.DB.prepare("UPDATE entitlements SET ends_at = ? WHERE account_id = ?").bind(Math.floor(Date.now() / 1000) - 10, a).run();
    const before = await lastAuditId();
    expect(await expireManualGrants(e, Math.floor(Date.now() / 1000))).toEqual([a]);
    expect(await getEntitlement(e.DB, a)).toMatchObject({ status: "expired", active: false, maxHubs: 0 });
    expect(await getEntitlement(e.DB, b)).toMatchObject({ status: "active", active: true });
    expect(await getEntitlement(e.DB, c)).toMatchObject({ status: "active", endsAt: null });
    expect((await e.DB.prepare("SELECT COUNT(*) n FROM hub_pair_codes WHERE account_id = ?").bind(a).first<any>()).n).toBe(0);
    expect((await pair({ code })).status).toBe(400);
    expect((await client(ownerA, env()).request("/api/hubs/pair/start", { method: "POST" })).status).toBe(402);
    expect(await e.DB.prepare("SELECT kind, actor, status FROM entitlement_history WHERE account_id = ? AND kind = 'expired'").bind(a).first()).toEqual({ kind: "expired", actor: "system:cron", status: "expired" });
    const audit = (await e.DB.prepare("SELECT actor, action, target, hash FROM audit_log WHERE id > ?").bind(before).all<any>()).results;
    expect(audit).toEqual([{ actor: "system:cron", action: "entitlement.expired", target: a, hash: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(await expireManualGrants(e)).toEqual([]); // idempotent
  });
  it("is part of the scheduled handler", async () => {
    const a = await newCustomer("exp-d@example.com", { plan: "pilot", days: 5 });
    await e.DB.prepare("UPDATE entitlements SET ends_at = unixepoch() - 1 WHERE account_id = ?").bind(a).run();
    const { default: worker } = await import("../src/index");
    await worker.scheduled!({ scheduledTime: Date.now(), cron: "23 * * * *", noRetry() {} } as unknown as ScheduledController, env() as any);
    expect((await getEntitlement(e.DB, a)).status).toBe("expired");
  });
  it("a reactivated pilot needs a new end date", async () => {
    const a = await newCustomer("exp-e@example.com", { plan: "pilot", days: 5 });
    await e.DB.prepare("UPDATE entitlements SET ends_at = unixepoch() - 1 WHERE account_id = ?").bind(a).run();
    await expireManualGrants(e);
    expect((await staff("POST", `/api/support/accounts/${a}/entitlement`, { status: "active" })).json.error).toBe("ends_at_in_past");
    const r = await staff("POST", `/api/support/accounts/${a}/entitlement`, { status: "active", days: 14 });
    expect(r.json).toMatchObject({ kind: "reactivate", entitlement: { status: "active", active: true } });
  });
});

describe("customer invites", () => {
  const invite = (b: Record<string, unknown>) => staff("POST", "/api/support/invites", b);
  const accept = (token: string, email: string, extra: Record<string, unknown> = {}) => pub("POST", "/api/invite/accept", { token, email, turnstileToken: "ok", ...extra });

  it("creates a single-use invite: hashed token, 14 day expiry, email with the invite link", async () => {
    const before = await lastAuditId();
    const r = await invite({ email: " New@Example.com ", plan: "pilot", note: "from waitlist" });
    expect(r.status).toBe(201);
    const row = (await e.DB.prepare("SELECT * FROM invites WHERE id = ?").bind(r.json.invite.id).first<any>())!;
    expect(row).toMatchObject({ email: "new@example.com", plan: "pilot", invited_by: `support:${ADMIN}`, accepted_at: null, revoked_at: null });
    expect(row.expires_at - row.created_at).toBe(14 * 86400);
    const mail = last("new@example.com");
    expect(mail.subject).toBe("You're invited to the Albena pilot");
    const url = new URL(mail.text.match(/https:\/\/\S+/)![0]);
    expect(url.origin + url.pathname).toBe("https://account.albena.ai/invite");
    const [id, secret] = url.searchParams.get("token")!.split(".");
    expect(id).toBe(row.id);
    expect(row.token_hash).toBe(await sha256(secret));
    expect(JSON.stringify(row)).not.toContain(secret);
    expect((await auditSince(before)).map((a) => a.action)).toEqual(["support.invite.create"]);
    expect(JSON.stringify((await e.DB.prepare("SELECT meta FROM audit_log WHERE action = 'support.invite.create'").first())) ).not.toContain(secret);
  });
  it("rejects bad input, a second live invite, and people who already have an account", async () => {
    expect((await invite({ email: "nope" })).json.error).toBe("invalid_email");
    expect((await invite({ email: "a@example.com", plan: "gold" })).json.error).toBe("invalid_plan");
    expect((await invite({ email: "a@example.com", plan: "comp" })).json.error).toBe("base_plan_required");
    expect((await invite({ email: "a@example.com" })).status).toBe(201);
    expect((await invite({ email: "A@example.com" })).json.error).toBe("invite_pending");
    const id = await newCustomer("have@example.com");
    expect(await invite({ email: "have@example.com" })).toMatchObject({ status: 409, json: { error: "already_customer", accountId: id } });
  });
  it("a failed delivery leaves no invite behind so staff can retry", async () => {
    const res = await app.request(ORIGIN + "/api/support/invites", {
      method: "POST", body: JSON.stringify({ email: "fail@example.com" }),
      headers: { "X-Requested-With": "albena-portal", Origin: ORIGIN, "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": await jwt() },
    }, env({ EMAIL: { send: async () => { throw new Error("smtp down"); } } as unknown as SendEmail }));
    expect(res.status).toBe(502);
    expect((await e.DB.prepare("SELECT COUNT(*) n FROM invites").first<any>()).n).toBe(0);
  });
  it("accepting requires the invited address; the invite creates the account + entitlement and starts the ordinary magic sign-in", async () => {
    const r = await invite({ email: "pat@example.com", plan: "pilot", days: 21, note: "pilot" });
    const token = inviteToken("pat@example.com");
    // wrong address: nothing is consumed
    const wrong = await accept(token, "someone-else@example.com");
    expect(wrong).toMatchObject({ status: 400, json: { error: "email_mismatch" } });
    expect((await e.DB.prepare("SELECT accepted_at, attempts FROM invites WHERE id = ?").bind(r.json.invite.id).first<any>())).toEqual({ accepted_at: null, attempts: 1 });
    expect(await e.DB.prepare("SELECT 1 x FROM users WHERE email = 'pat@example.com'").first()).toBeNull();
    // right address (case-insensitive)
    mailbox = [];
    const ok = await accept(token, "PAT@example.com");
    expect(ok.status).toBe(202);
    const acct = (await e.DB.prepare("SELECT a.id FROM accounts a JOIN users u ON u.id = a.owner WHERE u.email = 'pat@example.com'").first<{ id: string }>())!.id;
    const ent = await getEntitlement(e.DB, acct);
    expect(ent).toMatchObject({ plan: "pilot", status: "active", active: true, source: "manual", maxHubs: 1 });
    expect(ent.endsAt! - Date.now() / 1000).toBeGreaterThan(20 * 86400);
    expect(await e.DB.prepare("SELECT account_id, accepted_at IS NOT NULL a FROM invites WHERE id = ?").bind(r.json.invite.id).first()).toEqual({ account_id: acct, a: 1 });
    expect(await e.DB.prepare("SELECT actor, kind FROM entitlement_history WHERE account_id = ?").bind(acct).first()).toEqual({ actor: "invite", kind: "grant" });
    // no session yet: the person still has to prove they own the mailbox
    expect((await e.DB.prepare("SELECT COUNT(*) n FROM sessions WHERE user_id = ?").bind(acct).first<any>()).n).toBe(0);
    expect(mailbox).toHaveLength(1);
    expect(mailbox[0].subject).toBe("Sign in to Albena"); // the ordinary sign-in mail, not a second kind of login
    const session = await signInWithCode(ok, "pat@example.com");
    const me = await (await client(session, env()).request("/api/me")).json() as any;
    expect(me.user).toMatchObject({ accountId: acct, role: "owner", email: "pat@example.com" });
  });
  it("the link is single use", async () => {
    await invite({ email: "once@example.com" });
    const token = inviteToken("once@example.com");
    expect((await accept(token, "once@example.com")).status).toBe(202);
    expect(await accept(token, "once@example.com")).toMatchObject({ status: 400, json: { error: "invalid_or_expired_invite" } });
    const [res1, res2] = await Promise.all([accept(token, "once@example.com"), accept(token, "once@example.com")]);
    expect([res1.status, res2.status]).toEqual([400, 400]);
  });
  it("two simultaneous first redemptions: exactly one wins", async () => {
    await invite({ email: "race@example.com" });
    const token = inviteToken("race@example.com");
    const out = await Promise.all([accept(token, "race@example.com"), accept(token, "race@example.com")]);
    expect(out.map((o) => o.status).sort()).toEqual([202, 400]);
  });
  it("expires after 14 days and is useless when tampered with", async () => {
    const r = await invite({ email: "late@example.com" });
    const token = inviteToken("late@example.com");
    expect((await accept(token.replace(/.$/, (ch) => (ch === "0" ? "1" : "0")), "late@example.com")).status).toBe(400);
    expect((await accept("garbage", "late@example.com")).status).toBe(400);
    await e.DB.prepare("UPDATE invites SET expires_at = unixepoch() - 1 WHERE id = ?").bind(r.json.invite.id).run();
    expect(await accept(token, "late@example.com")).toMatchObject({ status: 400, json: { error: "invalid_or_expired_invite" } });
    expect(await e.DB.prepare("SELECT 1 x FROM users WHERE email = 'late@example.com'").first()).toBeNull();
    expect((await staff("GET", "/api/support/invites")).json.invites.find((i: any) => i.id === r.json.invite.id).status).toBe("expired");
  });
  it("locks after five wrong addresses", async () => {
    await invite({ email: "lock@example.com" });
    const token = inviteToken("lock@example.com");
    for (let i = 0; i < 5; i++) expect((await accept(token, `guess${i}@example.com`)).json.error).toBe("email_mismatch");
    expect(await accept(token, "lock@example.com")).toMatchObject({ status: 429, json: { error: "invite_locked" } });
  });
  it("revoked invites stop working; resend replaces the link and is rate limited", async () => {
    const r = await invite({ email: "rev@example.com" });
    const first = inviteToken("rev@example.com");
    expect((await staff("POST", `/api/support/invites/${r.json.invite.id}/resend`)).json.error).toBe("too_soon");
    await e.DB.prepare("UPDATE invites SET last_sent_at = last_sent_at - 120 WHERE id = ?").bind(r.json.invite.id).run();
    expect((await staff("POST", `/api/support/invites/${r.json.invite.id}/resend`)).status).toBe(200);
    const second = inviteToken("rev@example.com");
    expect(second).not.toBe(first);
    expect((await accept(first, "rev@example.com")).status).toBe(400); // old email's link is dead
    expect((await staff("DELETE", `/api/support/invites/${r.json.invite.id}`)).status).toBe(200);
    expect((await accept(second, "rev@example.com")).status).toBe(400);
    expect((await staff("POST", `/api/support/invites/${r.json.invite.id}/resend`)).json.error).toBe("invite_closed");
    expect((await staff("DELETE", `/api/support/invites/${r.json.invite.id}`)).status).toBe(404);
  });
  it("an invite never downgrades or replaces a live entitlement", async () => {
    // account exists by the time the invite is accepted (e.g. staff created it meanwhile)
    await invite({ email: "race2@example.com", plan: "pilot" });
    const token = inviteToken("race2@example.com");
    const id = await newCustomer("race2@example.com", { plan: "estate" });
    expect(await accept(token, "race2@example.com")).toMatchObject({ status: 202 });
    expect(await getEntitlement(e.DB, id)).toMatchObject({ plan: "estate", active: true });
  });
  it("bulk invites report a result per address", async () => {
    await newCustomer("existing@example.com");
    const r = await staff("POST", "/api/support/invites/bulk", { emails: ["b1@example.com", "B1@example.com", "b2@example.com", "bad", "existing@example.com"], plan: "pilot", days: 14 });
    expect(r.status).toBe(200);
    expect(r.json.results.map((x: any) => [x.email, x.ok, x.error])).toEqual([
      ["b1@example.com", true, undefined], ["b2@example.com", true, undefined], ["bad", false, "invalid_email"], ["existing@example.com", false, "already_customer"],
    ]);
    expect((await staff("POST", "/api/support/invites/bulk", { emails: [] })).status).toBe(400);
    expect((await staff("POST", "/api/support/invites/bulk", { emails: Array.from({ length: 51 }, (_, i) => `x${i}@example.com`) })).status).toBe(400);
    expect(mailbox.filter((m) => m.subject === "You're invited to the Albena pilot")).toHaveLength(2);
  });
  it("lists invites with status and never exposes token material", async () => {
    await invite({ email: "list@example.com" });
    const { json } = await staff("GET", "/api/support/invites");
    expect(json.invites[0]).toMatchObject({ email: "list@example.com", status: "pending" });
    expect(JSON.stringify(json)).not.toMatch(/token_hash|tokenHash/);
  });
});

describe("staff notes", () => {
  it("are append-only and staff-only", async () => {
    const id = await newCustomer("notes@example.com");
    const n1 = await staff("POST", `/api/support/accounts/${id}/notes`, { body: "called, wants Mac" });
    expect(n1).toMatchObject({ status: 201, json: { note: { actor: `support:${ADMIN}`, body: "called, wants Mac" } } });
    await staff("POST", `/api/support/accounts/${id}/notes`, { body: "second" }, "second@example.com");
    await expect(e.DB.prepare("UPDATE account_notes SET body = 'edited' WHERE account_id = ?").bind(id).run()).rejects.toThrow(/notes_append_only/);
    await expect(e.DB.prepare("DELETE FROM account_notes WHERE account_id = ?").bind(id).run()).rejects.toThrow(/notes_append_only/);
    expect((await staff("POST", `/api/support/accounts/${id}/notes`, { body: "  " })).json.error).toBe("invalid_note");
    expect((await staff("POST", `/api/support/accounts/${id}/notes`, { body: "x".repeat(2001) })).status).toBe(400);
    expect((await staff("POST", `/api/support/accounts/nope/notes`, { body: "x" })).status).toBe(404);
    // customers never see them
    const owner = await login({ id, email: "notes@example.com", accountId: id, role: "owner" });
    const exp = JSON.stringify(await (await client(owner, env()).request("/api/account/export")).json());
    expect(exp).not.toContain("called, wants Mac");
  });
  it("go away with the account when the customer deletes it", async () => {
    const id = await newCustomer("gone@example.com", { plan: "pilot" });
    await staff("POST", `/api/support/accounts/${id}/notes`, { body: "remember" });
    await staff("POST", `/api/support/accounts/${id}/orders`, { edition: "mac", notes: "ship to 1 Main St" });
    await staff("POST", `/api/support/accounts/${id}/reserved-hubs`, { serial: "GONE-0001", edition: "mac" });
    const owner = await login({ id, email: "gone@example.com", accountId: id, role: "owner" });
    expect((await client(owner, env()).request("/api/account/delete", { method: "POST", body: JSON.stringify({ confirm: "DELETE" }) })).status).toBe(200);
    for (const t of ["account_notes", "entitlement_history", "reserved_hubs", "license_keys"]) expect([t, (await e.DB.prepare(`SELECT COUNT(*) n FROM ${t} WHERE account_id = ?`).bind(id).first<any>()).n]).toEqual([t, 0]);
    expect(await e.DB.prepare("SELECT staff_notes, tracking FROM hardware_orders WHERE account_id = ?").bind(id).first()).toEqual({ staff_notes: null, tracking: null });
  });
});

describe("manual orders", () => {
  const patch = (id: string, b: unknown) => staff("PATCH", `/api/support/orders/${id}`, b);
  it("runs pending -> preparing -> shipped (carrier, tracking) -> delivered and shows in the customer's orders", async () => {
    const acct = await newCustomer("ord@example.com", { plan: "hub_mac" });
    const created = await staff("POST", `/api/support/accounts/${acct}/orders`, { edition: "nvidia", notes: "gift wrap" });
    expect(created.status).toBe(201);
    const id = created.json.order.id;
    const owner = await login({ id: acct, email: "ord@example.com", accountId: acct, role: "owner" });
    const mine = async () => ((await (await client(owner, env()).request("/api/billing/orders")).json()) as any).orders;
    expect((await mine())[0]).toMatchObject({ id, plan: "hub_nvidia", source: "manual", edition: "nvidia", shippingStatus: "pending", refunded: false, carrier: null, tracking: null });
    expect(JSON.stringify(await mine())).not.toContain("gift wrap"); // staff notes stay internal
    expect((await patch(id, { status: "delivered" })).status).toBe(409); // cannot skip
    expect((await patch(id, { status: "preparing" })).status).toBe(200);
    expect((await patch(id, { status: "shipped" })).json.error).toBe("carrier_and_tracking_required");
    expect((await patch(id, { status: "shipped", carrier: "UPS" })).json.error).toBe("carrier_and_tracking_required");
    expect((await patch(id, { status: "shipped", carrier: "UPS", tracking: "1Z999" })).status).toBe(200);
    expect((await mine())[0]).toMatchObject({ shippingStatus: "shipped", carrier: "UPS", tracking: "1Z999" });
    expect((await patch(id, { status: "cancelled" })).status).toBe(409); // already shipped
    expect((await patch(id, { status: "delivered" })).status).toBe(200);
    expect((await patch(id, { status: "preparing" })).status).toBe(409);
    expect(await e.DB.prepare("SELECT shipped_at IS NOT NULL s, delivered_at IS NOT NULL d, created_by FROM hardware_orders WHERE id = ?").bind(id).first()).toEqual({ s: 1, d: 1, created_by: `support:${ADMIN}` });
    const actions = (await e.DB.prepare("SELECT action FROM audit_log WHERE target = ? ORDER BY id").bind(id).all<any>()).results.map((r) => r.action);
    expect(actions).toEqual(["support.order.create", "support.order.preparing", "support.order.shipped", "support.order.delivered"]);
  });
  it("can be cancelled before shipping, and a stale click cannot move it twice", async () => {
    const acct = await newCustomer("ord2@example.com");
    const id = (await staff("POST", `/api/support/accounts/${acct}/orders`, { edition: "mac" })).json.order.id;
    const [a, b] = await Promise.all([patch(id, { status: "preparing" }), patch(id, { status: "cancelled" })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const id2 = (await staff("POST", `/api/support/accounts/${acct}/orders`, { edition: "mac" })).json.order.id;
    expect((await patch(id2, { status: "cancelled" })).status).toBe(200);
    expect((await patch(id2, { status: "preparing" })).status).toBe(409);
  });
  it("validates edition and leaves Stripe orders alone", async () => {
    const acct = await newCustomer("ord3@example.com");
    expect((await staff("POST", `/api/support/accounts/${acct}/orders`, { edition: "pi" })).json.error).toBe("invalid_edition");
    expect((await staff("POST", `/api/support/accounts/nope/orders`, { edition: "mac" })).status).toBe(404);
    await e.DB.prepare("INSERT INTO hardware_orders (id,account_id,plan,checkout_session_id,created_at) VALUES ('hw_s',?,'hub_mac','cs_s',1)").bind(acct).run();
    expect((await patch("hw_s", { status: "preparing" })).json.error).toBe("not_manual");
    expect((await patch("nope", { status: "preparing" })).status).toBe(404);
  });
});

describe("pre-provisioned Hubs (serial)", () => {
  const reserve = (acct: string, b: Record<string, unknown>) => staff("POST", `/api/support/accounts/${acct}/reserved-hubs`, { edition: "mac", ...b });
  it("binds the Hub that presents the serial and its key, once, with no code", async () => {
    const acct = await newCustomer("res@example.com", { plan: "hub_mac" });
    const r = await reserve(acct, { serial: " alb-0001 ", name: "Kitchen Hub" });
    expect(r.status).toBe(201);
    expect(r.json.reservedHub.serial).toBe("ALB-0001");
    const before = await lastAuditId();
    const ok = await pair({ serial: "alb-0001" });
    expect(ok.status).toBe(200);
    const hub = (await e.DB.prepare("SELECT account_id, name, edition FROM hubs WHERE id = ?").bind(ok.json.hubId).first<any>())!;
    expect(hub).toEqual({ account_id: acct, name: "Kitchen Hub", edition: "mac" });
    expect(await e.DB.prepare("SELECT hub_id, used_at IS NOT NULL u FROM reserved_hubs WHERE serial = 'ALB-0001'").first()).toEqual({ hub_id: ok.json.hubId, u: 1 });
    expect((await auditSince(before)).map((a) => a.action)).toEqual(["hub.pair.complete"]);
    expect(JSON.parse((await e.DB.prepare("SELECT meta FROM audit_log WHERE action = 'hub.pair.complete' ORDER BY id DESC LIMIT 1").first<any>())!.meta)).toMatchObject({ via: "serial", accountId: acct });
    // single use: the same serial (even with a different key) does nothing more
    expect(await pair({ serial: "ALB-0001" })).toMatchObject({ status: 400, json: { error: "invalid or expired code" } });
    expect(await hubCount(acct)).toBe(1);
  });
  it("still needs the Hub's own key: a key can only be registered once, and a pinned key must match", async () => {
    const acct = await newCustomer("res2@example.com", { plan: "estate" });
    const pinned = await keypair();
    await reserve(acct, { serial: "ALB-PIN-1", publicKey: pinned });
    const other = await pub("POST", "/api/hubs/pair/complete", { serial: "ALB-PIN-1", hubPublicKey: await keypair(), edition: "mac", profile: "home", version: "1.0.0" });
    expect(other.status).toBe(400);
    const good = await pub("POST", "/api/hubs/pair/complete", { serial: "ALB-PIN-1", hubPublicKey: pinned, edition: "mac", profile: "home", version: "1.0.0" });
    expect(good.status).toBe(200);
    expect((await reserve(acct, { serial: "ALB-PIN-2", publicKey: "not-base64" })).json.error).toBe("invalid_public_key");
    // an already registered key cannot bind a second reservation (UNIQUE key), and the reservation stays usable
    await reserve(acct, { serial: "ALB-DUP-1" });
    const dup = await pub("POST", "/api/hubs/pair/complete", { serial: "ALB-DUP-1", hubPublicKey: pinned, edition: "mac", profile: "home", version: "1.0.0" });
    expect(dup.status).toBe(409);
    expect((await e.DB.prepare("SELECT used_at FROM reserved_hubs WHERE serial = 'ALB-DUP-1'").first<any>()).used_at).toBeNull();
  });
  it("is refused when the edition differs, the reservation expired, or the plan is not active / has no free slot", async () => {
    const acct = await newCustomer("res3@example.com", { plan: "hub_mac" });
    await reserve(acct, { serial: "ALB-ED-1" });
    expect((await pair({ serial: "ALB-ED-1" }, "nvidia")).status).toBe(400);
    await reserve(acct, { serial: "ALB-EXP-1" });
    await e.DB.prepare("UPDATE reserved_hubs SET expires_at = unixepoch() - 1 WHERE serial = 'ALB-EXP-1'").run();
    expect((await pair({ serial: "ALB-EXP-1" })).status).toBe(400);
    await staff("POST", `/api/support/accounts/${acct}/entitlement`, { status: "suspended" });
    expect((await pair({ serial: "ALB-ED-1" })).status).toBe(402);
    expect((await e.DB.prepare("SELECT used_at FROM reserved_hubs WHERE serial = 'ALB-ED-1'").first<any>()).used_at).toBeNull();
    await staff("POST", `/api/support/accounts/${acct}/entitlement`, { status: "active" });
    expect((await pair({ serial: "ALB-ED-1" })).status).toBe(200);
    await reserve(acct, { serial: "ALB-SLOT-2" });
    expect((await pair({ serial: "ALB-SLOT-2" })).status).toBe(402); // hub_mac allows one Hub
    expect(await hubCount(acct)).toBe(1);
    const noPlan = await newCustomer("res4@example.com");
    await reserve(noPlan, { serial: "ALB-NOPLAN" });
    expect((await pair({ serial: "ALB-NOPLAN" })).status).toBe(402);
  });
  it("validates serials, rejects duplicates, can be cancelled while unused, and the normal code flow still works", async () => {
    const acct = await newCustomer("res5@example.com", { plan: "hub_mac" });
    expect((await reserve(acct, { serial: "x" })).json.error).toBe("invalid_serial");
    expect((await reserve(acct, { serial: "ALB-OK-1", edition: "pi" })).json.error).toBe("invalid_edition");
    const r = await reserve(acct, { serial: "ALB-OK-1" });
    expect((await reserve(acct, { serial: "alb-ok-1" })).json.error).toBe("serial_taken");
    expect((await staff("DELETE", `/api/support/reserved-hubs/${r.json.reservedHub.id}`)).status).toBe(200);
    expect((await pair({ serial: "ALB-OK-1" })).status).toBe(400);
    const owner = await login({ id: acct, email: "res5@example.com", accountId: acct, role: "owner" });
    const code = ((await (await client(owner, env()).request("/api/hubs/pair/start", { method: "POST" })).json()) as any).code;
    expect((await pair({ code })).status).toBe(200);
    // exactly one credential is accepted
    expect((await pub("POST", "/api/hubs/pair/complete", { code: "AAAAAAAA", serial: "ALB-OK-1", hubPublicKey: await keypair(), edition: "mac", profile: "home", version: "1.0.0" })).status).toBe(400);
    expect((await pub("POST", "/api/hubs/pair/complete", { hubPublicKey: await keypair(), edition: "mac", profile: "home", version: "1.0.0" })).status).toBe(400);
    const used = await reserve(acct, { serial: "ALB-USED-1" });
    await e.DB.prepare("UPDATE reserved_hubs SET used_at = 1 WHERE id = ?").bind(used.json.reservedHub.id).run();
    expect((await staff("DELETE", `/api/support/reserved-hubs/${used.json.reservedHub.id}`)).status).toBe(404);
  });
});

describe("BYO license keys", () => {
  const mint = (acct: string, b: Record<string, unknown> = {}) => staff("POST", `/api/support/accounts/${acct}/license-keys`, b);
  it("are shown once, stored hashed, and pair a BYO Hub without a code", async () => {
    const acct = await newCustomer("byo@example.com", { plan: "byo" });
    const r = await mint(acct, { label: "Dana's Mac mini" });
    expect(r.status).toBe(201);
    const key: string = r.json.licenseKey;
    expect(key).toMatch(/^ALB-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const rows = JSON.stringify((await e.DB.prepare("SELECT * FROM license_keys").all()).results);
    expect(rows).not.toContain(key.replace(/-/g, "")); expect(rows).not.toContain(key);
    expect(rows).toContain(key.slice(-4));
    const detail = await staff("GET", `/api/support/accounts/${acct}`);
    expect(JSON.stringify(detail.json)).not.toContain(key);
    expect(detail.json.licenseKeys[0]).toMatchObject({ hint: key.slice(-4), label: "Dana's Mac mini", revokedAt: null, useCount: 0 });
    const paired = await pair({ licenseKey: key.toLowerCase() });
    expect(paired.status).toBe(200);
    expect(await e.DB.prepare("SELECT account_id FROM hubs WHERE id = ?").bind(paired.json.hubId).first()).toEqual({ account_id: acct });
    expect(JSON.parse((await e.DB.prepare("SELECT meta FROM audit_log WHERE action = 'hub.pair.complete' ORDER BY id DESC LIMIT 1").first<any>())!.meta).via).toBe("license_key");
    // BYO has one slot: the key is not a second Hub
    expect((await pair({ licenseKey: key })).status).toBe(402);
    expect((await e.DB.prepare("SELECT use_count, last_used_at IS NOT NULL u FROM license_keys").first<any>())).toEqual({ use_count: 1, u: 1 });
  });
  it("can re-pair after the Hub is removed, and stop working when revoked", async () => {
    const acct = await newCustomer("byo2@example.com", { plan: "byo" });
    const { json } = await mint(acct);
    const owner = await login({ id: acct, email: "byo2@example.com", accountId: acct, role: "owner" });
    const hubId = (await pair({ licenseKey: json.licenseKey })).json.hubId;
    expect((await client(owner, env()).request(`/api/hubs/${hubId}`, { method: "DELETE" })).status).toBe(200);
    expect((await pair({ licenseKey: json.licenseKey })).status).toBe(200);
    expect((await staff("DELETE", `/api/support/license-keys/${json.id}`)).status).toBe(200);
    const owner2 = await login({ id: acct, email: "byo2@example.com", accountId: acct, role: "owner" });
    const hub2 = (await e.DB.prepare("SELECT id FROM hubs WHERE account_id = ?").bind(acct).first<any>()).id;
    await client(owner2, env()).request(`/api/hubs/${hub2}`, { method: "DELETE" });
    expect(await pair({ licenseKey: json.licenseKey })).toMatchObject({ status: 400 });
    expect((await staff("DELETE", `/api/support/license-keys/${json.id}`)).status).toBe(404);
  });
  it("only exist for BYO accounts, only pair while the plan is BYO and active, and reject malformed or unknown keys", async () => {
    const mac = await newCustomer("byo3@example.com", { plan: "hub_mac" });
    expect((await mint(mac)).json.error).toBe("not_byo");
    expect((await mint("nope")).status).toBe(404);
    const acct = await newCustomer("byo4@example.com", { plan: "byo" });
    const { json } = await mint(acct);
    await staff("POST", `/api/support/accounts/${acct}/entitlement`, { plan: "estate" }); // plan changed away from BYO
    expect((await pair({ licenseKey: json.licenseKey })).status).toBe(402);
    await staff("POST", `/api/support/accounts/${acct}/entitlement`, { plan: "byo", status: "suspended" });
    expect((await pair({ licenseKey: json.licenseKey })).status).toBe(402);
    expect((await pair({ licenseKey: "ALB-AAAAA-AAAAA-AAAAA-AAAAA" })).status).toBe(400);
    expect((await pair({ licenseKey: "short" })).status).toBe(400);
    // a comp copy of BYO counts as BYO
    await staff("POST", `/api/support/accounts/${acct}/entitlement`, { plan: "comp", basePlan: "byo" });
    expect((await pair({ licenseKey: json.licenseKey })).status).toBe(200);
  });
  it("failed attempts count against the same per-IP limiter as codes", async () => {
    const ip = "10.77.0.1";
    const results = [];
    for (let i = 0; i < 22; i++) results.push((await pub("POST", "/api/hubs/pair/complete", { licenseKey: "ALB-AAAAA-AAAAA-AAAAA-AAAAA", hubPublicKey: await keypair(), edition: "mac", profile: "home", version: "1.0.0" }, { "cf-connecting-ip": ip })).status);
    expect(results.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(results.at(-1)).toBe(429);
  });
});

describe("household invites", () => {
  const ownerSession = async (id: string) => client(await login(await seedOwner(id)), env());
  const memberSignIn = async (email: string) => {
    const start = await pub("POST", "/api/auth/magic/start", { email, turnstileToken: "t" });
    const session = await signInWithCode(start, email);
    return { session, me: ((await (await client(session, env()).request("/api/me")).json()) as any).user };
  };
  it("owner invites an email, the person signs in, and joins as a member (not as an owner of a second account)", async () => {
    const owner = await ownerSession("hh-o1");
    const r = await owner.request("/api/account/members/invite", { method: "POST", body: JSON.stringify({ email: "Kid@Example.com" }) });
    expect(r.status).toBe(201);
    expect(last("kid@example.com").text).toContain("hh-o1@example.com");
    expect(last("kid@example.com").subject).toBe("You're invited to an Albena household");
    const pending = ((await (await owner.request("/api/account")).json()) as any).invites;
    expect(pending).toEqual([expect.objectContaining({ email: "kid@example.com" })]);
    const { me, session } = await memberSignIn("kid@example.com");
    expect(me).toMatchObject({ accountId: "hh-o1", role: "member", email: "kid@example.com" });
    expect(await e.DB.prepare("SELECT COUNT(*) n FROM accounts WHERE owner = ?").bind(me.id).first<any>()).toEqual({ n: 0 });
    const acct = ((await (await owner.request("/api/account")).json()) as any);
    expect(acct.members.map((m: any) => [m.email, m.role])).toEqual([["hh-o1@example.com", "owner"], ["kid@example.com", "member"]]);
    expect(acct.invites).toEqual([]);
    // a member cannot invite, remove or see invites
    const asMember = client(session, env());
    expect((await asMember.request("/api/account/members/invite", { method: "POST", body: JSON.stringify({ email: "x@example.com" }) })).status).toBe(403);
    expect(((await (await asMember.request("/api/account")).json()) as any).invites).toEqual([]);
    // signing in again keeps them in the household
    expect((await memberSignIn("kid@example.com")).me.accountId).toBe("hh-o1");
    expect((await e.DB.prepare("SELECT action FROM audit_log WHERE action = 'household.invite.accepted'").first())).toBeTruthy();
  });
  it("validates: owners only, valid email, no duplicates, existing members, and pending limit", async () => {
    const owner = await ownerSession("hh-o2");
    const inv = (email: unknown) => owner.request("/api/account/members/invite", { method: "POST", body: JSON.stringify({ email }) });
    expect((await inv("nope")).status).toBe(400);
    expect((await inv("hh-o2@example.com")).status).toBe(409); // already a member (the owner)
    expect((await inv("a@example.com")).status).toBe(201);
    expect(((await (await inv("a@example.com")).json()) as any).error).toBe("already_invited");
    for (let i = 0; i < 9; i++) expect((await inv(`p${i}@example.com`)).status).toBe(201);
    expect(((await (await inv("overflow@example.com")).json()) as any).error).toBe("too_many_invites");
    const anon = client(undefined, env());
    expect((await anon.request("/api/account/members/invite", { method: "POST", body: JSON.stringify({ email: "z@example.com" }) })).status).toBe(401);
  });
  it("owner can revoke, and expired or revoked invites do not join anyone", async () => {
    const owner = await ownerSession("hh-o3");
    const { invite } = (await (await owner.request("/api/account/members/invite", { method: "POST", body: JSON.stringify({ email: "r1@example.com" }) })).json()) as any;
    expect((await owner.request(`/api/account/members/invites/${invite.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await owner.request(`/api/account/members/invites/${invite.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await memberSignIn("r1@example.com")).me.accountId).not.toBe("hh-o3");
    await owner.request("/api/account/members/invite", { method: "POST", body: JSON.stringify({ email: "r2@example.com" }) });
    await e.DB.prepare("UPDATE member_invites SET expires_at = unixepoch() - 1 WHERE email = 'r2@example.com'").run();
    expect((await memberSignIn("r2@example.com")).me.accountId).not.toBe("hh-o3");
    // another owner cannot revoke it
    const other = await ownerSession("hh-o3b");
    const again = ((await (await owner.request("/api/account/members/invite", { method: "POST", body: JSON.stringify({ email: "r3@example.com" }) })).json()) as any).invite;
    expect((await other.request(`/api/account/members/invites/${again.id}`, { method: "DELETE" })).status).toBe(404);
  });
  it("someone who already runs a real account keeps it; the invite stays pending", async () => {
    const owner = await ownerSession("hh-o4");
    const busy = await newCustomer("busy@example.com", { plan: "hub_mac" });
    await owner.request("/api/account/members/invite", { method: "POST", body: JSON.stringify({ email: "busy@example.com" }) });
    expect((await memberSignIn("busy@example.com")).me.accountId).toBe(busy);
    expect(await e.DB.prepare("SELECT accepted_at FROM member_invites WHERE email = 'busy@example.com'").first()).toEqual({ accepted_at: null });
  });
  it("owner removes a member: access ends at once, and the owner cannot be removed", async () => {
    const owner = await ownerSession("hh-o5");
    await owner.request("/api/account/members/invite", { method: "POST", body: JSON.stringify({ email: "leave@example.com" }) });
    const { session, me } = await memberSignIn("leave@example.com");
    const asMember = client(session, env());
    expect((await asMember.request("/api/me")).status).toBe(200);
    expect((await owner.request("/api/account/members/hh-o5", { method: "DELETE" })).status).toBe(404);
    expect((await owner.request(`/api/account/members/${me.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await asMember.request("/api/me")).status).toBe(401);
    expect((await owner.request(`/api/account/members/${me.id}`, { method: "DELETE" })).status).toBe(404);
    // they get an ordinary account of their own next time
    const again = await memberSignIn("leave@example.com");
    expect(again.me.accountId).toBe(me.id);
  });
  it("members of one household cannot touch another's", async () => {
    const o1 = await ownerSession("hh-o6"), o2 = await ownerSession("hh-o7");
    const m = await seedMember("hh-m6", "hh-o6");
    await o1.request("/api/account/members/invite", { method: "POST", body: JSON.stringify({ email: "pending6@example.com" }) });
    const id = (await e.DB.prepare("SELECT id FROM member_invites WHERE account_id = 'hh-o6'").first<any>()).id;
    expect((await o2.request(`/api/account/members/${m.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await o2.request(`/api/account/members/invites/${id}`, { method: "DELETE" })).status).toBe(404);
    expect(await e.DB.prepare("SELECT COUNT(*) n FROM members WHERE account_id = 'hh-o6'").first()).toEqual({ n: 2 });
  });
});

describe("customer detail", () => {
  it("returns plan, users, hubs, orders, history, notes, invites and an audit timeline", async () => {
    const acct = await newCustomer("detail@example.com", { plan: "pilot", name: "Dee" });
    await staff("POST", `/api/support/accounts/${acct}/notes`, { body: "first call" });
    await staff("POST", `/api/support/accounts/${acct}/orders`, { edition: "mac" });
    await staff("POST", `/api/support/accounts/${acct}/reserved-hubs`, { serial: "ALB-DET-1", edition: "mac" });
    const paired = await pair({ serial: "ALB-DET-1" });
    await e.DB.prepare("UPDATE hubs SET version = '2.1.0', health_json = ?, last_seen = ? WHERE id = ?").bind(JSON.stringify({ ok: true, services: [["voice", "ok"]] }), 1234567, paired.json.hubId).run();
    const { status, json } = await staff("GET", `/api/support/accounts/${acct}`);
    expect(status).toBe(200);
    expect(json.account).toMatchObject({ id: acct, ownerEmail: "detail@example.com" });
    expect(json.users).toEqual([{ id: acct, email: "detail@example.com", name: "Dee", role: "owner" }]);
    expect(json.entitlement).toMatchObject({ plan: "pilot", source: "manual", active: true });
    expect(json.hubs[0]).toMatchObject({ id: paired.json.hubId, version: "2.1.0", lastSeen: 1234567, health: { ok: true } });
    expect(json.reservedHubs[0]).toMatchObject({ serial: "ALB-DET-1", hubId: paired.json.hubId });
    expect(json.orders[0]).toMatchObject({ source: "manual", status: "pending", edition: "mac" });
    expect(json.notes[0]).toMatchObject({ body: "first call", actor: `support:${ADMIN}` });
    expect(json.history[0]).toMatchObject({ kind: "grant", plan: "pilot" });
    const actions = json.audit.map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["support.account.create", "support.entitlement.grant", "support.note.add", "support.order.create", "hub.pair.complete"]));
    expect((await staff("GET", "/api/support/accounts/nope")).status).toBe(404);
    expect((await e.DB.prepare("SELECT action FROM audit_log WHERE action = 'support.account.view'").first())).toBeTruthy();
  });
  it("the account list carries source and end date", async () => {
    await newCustomer("list1@example.com", { plan: "pilot" });
    const { json } = await staff("GET", "/api/support/accounts");
    expect(json.accounts.find((a: any) => a.email === "list1@example.com")).toMatchObject({ plan: "pilot", status: "active", source: "manual", comp: 0 });
  });
});

describe("staff pages", () => {
  it("serves one static page for every /support/customers/<id>, behind the same gate", async () => {
    const assets = { fetch: vi.fn(async (req: Request) => new Response(`page:${new URL(req.url).pathname}`)) } as unknown as Fetcher;
    const res = await app.request(ORIGIN + "/support/customers/acc-123", { headers: { "Cf-Access-Jwt-Assertion": await jwt() } }, env({ ASSETS: assets }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("page:/support/customer");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    const denied = await app.request(ORIGIN + "/support/customers/acc-123", {}, env({ ASSETS: assets }));
    expect(denied.status).toBe(403);
    const cust = client(await login(await seedOwner("co-pg")), env({ ASSETS: assets }));
    expect((await cust.request("/support/customers/acc-123")).status).toBe(403);
    expect((await cust.request("/support/invite")).status).toBe(403);
  });
});
