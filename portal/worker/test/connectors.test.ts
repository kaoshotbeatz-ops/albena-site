import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { app } from "../src/index";
import { applyEntitlement } from "../src/billing/entitlements";
import { b64encode, sha256Hex } from "../src/hubs/crypto";
import { MAX_BODY, parseHeartbeat } from "../src/hubs/schema";
import { CATALOG, CATEGORIES } from "../src/connectors/catalog";
import { labelOk, parseConnectors } from "../src/connectors/schema";
import { ORIGIN, clearPortalTables, client, e, login, seedMember, seedOwner, testBindings } from "./helpers";

const TEAM = "test-team.cloudflareaccess.com", AUD = "aud-test", ADMIN = "omar@example.com";
const env = () => testBindings({ TEAM_DOMAIN: TEAM, ADMIN_AUD: AUD, SUPPORT_ADMIN_EMAILS: ADMIN });
let keys: CryptoKeyPair;

beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) =>
    String(input).startsWith(`https://${TEAM}/cdn-cgi/access/certs`) ? new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Content-Type": "application/json" } }) : real(input, init)));
});

const good = () => [
  { id: "home_assistant", state: "connected", access: "write", kind: "builtin", last_used_h: 3 },
  { id: "slack", state: "needs_attention", access: "read", kind: "builtin" },
  { id: "jellyfin", state: "off", access: "read", kind: "builtin", last_used_h: 0 },
  { id: "custom", label: "Garage sensors (MCP)", state: "connected", access: "read", kind: "mcp", last_used_h: 12 },
];
const hb = (connectors?: unknown, extra: Record<string, unknown> = {}) => ({
  version: "1.8.2", profile: "home", updateChannel: "stable", health: { ok: true, services: [["voice", "ok"]] },
  stats: { cpu_pct: 10, ...(connectors === undefined ? {} : { connectors }), ...extra },
});

describe("catalog", () => {
  it("has unique ids, valid categories and every category is used", () => {
    expect(new Set(CATALOG.map((c) => c.id)).size).toBe(CATALOG.length);
    const cats = new Set<string>(CATEGORIES.map((c) => c.id));
    expect(CATALOG.every((c) => cats.has(c.category) && c.name && c.description)).toBe(true);
    expect(new Set(CATALOG.map((c) => c.category)).size).toBe(CATEGORIES.length);
    expect(CATALOG.every((c) => /^[a-z0-9_]{2,32}$/.test(c.id))).toBe(true);
  });
});

describe("connectors schema (strict)", () => {
  const mut = (f: (a: any[]) => void) => { const a: any[] = JSON.parse(JSON.stringify(good())); f(a); return parseConnectors(a); };
  it("accepts a valid array, an empty one, and 60 entries", () => {
    expect(parseConnectors(good()).ok).toBe(true);
    expect(parseConnectors([]).ok).toBe(true);
    expect(parseHeartbeat(hb(good())).ok).toBe(true);
    const many = Array.from({ length: 60 }, (_, i) => ({ id: "custom", label: `Tool ${i}`, state: "off", access: "read", kind: "rest" }));
    expect(parseConnectors(many).ok).toBe(true);
    expect(JSON.stringify(hb(many)).length).toBeLessThan(MAX_BODY);
    expect(parseConnectors([...many, many[0]]).ok).toBe(false);
  });
  it("rejects unknown keys, bad enums, bad ids and bad numbers", () => {
    for (const f of [
      (a: any[]) => { a[0].url = "x"; }, (a: any[]) => { a[0].token = "x"; }, (a: any[]) => { a[0].state = "ok"; }, (a: any[]) => { a[0].access = "admin"; },
      (a: any[]) => { a[0].kind = "soap"; }, (a: any[]) => { a[0].id = "not_in_catalog"; }, (a: any[]) => { a[0].id = 5; }, (a: any[]) => { delete a[0].state; },
      (a: any[]) => { a[0].last_used_h = -1; }, (a: any[]) => { a[0].last_used_h = 1.5; }, (a: any[]) => { a[0].last_used_h = 9000; }, (a: any[]) => { a[0].last_used_h = "3"; },
      (a: any[]) => { a[1] = "slack"; }, (a: any[]) => { a.push({ ...a[0] }); }, (a: any[]) => { a[3].kind = "builtin"; },
      (a: any[]) => { a[3].id = "custom"; delete a[3].label; }, (a: any[]) => { a[0].label = "Home"; }, (a: any[]) => { a[1].access = "write"; a[1].id = "cameras"; },
    ]) expect(mut(f).ok).toBe(false);
    expect(parseConnectors({}).ok).toBe(false);
    expect(parseConnectors("x").ok).toBe(false);
    expect(parseHeartbeat(hb(good(), { extra: 1 })).ok).toBe(false);
  });
  it("accepts optional verified boolean only, stores and passes it through", () => {
    const r = parseConnectors([{ id: "slack", state: "connected", access: "read", kind: "builtin", verified: false }, { id: "jellyfin", state: "connected", access: "read", kind: "builtin", verified: true }]);
    expect(r.ok && r.value.map((x) => x.verified)).toEqual([false, true]);
    for (const v of ["false", 0, 1, null, "yes", {}]) expect(mut((a: any[]) => { a[0].verified = v; }).ok).toBe(false);
    expect(parseConnectors([{ id: "slack", state: "connected", access: "read", kind: "builtin", verified: true, extra: 1 }]).ok).toBe(false);
  });
  it("allows a catalog id over mcp with a label, and write on write-capable entries only", () => {
    expect(parseConnectors([{ id: "github", label: "GitHub MCP", state: "connected", access: "write", kind: "mcp" }]).ok).toBe(true);
    expect(parseConnectors([{ id: "cameras", state: "connected", access: "write", kind: "builtin" }]).ok).toBe(false);
  });
  it("label guard rejects addresses, hosts, emails, IPs, paths and odd characters", () => {
    for (const l of ["me@example.com", "user@host", "https://x.io", "http://10.0.0.5", "ftp://a", "files.example.com", "api.openai.com", "www.thing", "example.io", "notion.so", "10.0.0.5", "192.168.1.20 nas",
      "a/b", "a\\b", "host:8080", "x".repeat(49), "", " lead", "trail ", "<b>x</b>", "a\nb", "emoji 😀", "a;b", "key=abc", "sk_live_1234$"]) expect([l, labelOk(l)]).toEqual([l, false]);
    for (const l of ["Garage sensors", "Weather MCP", "Billing (REST)", "Kids' tablet", "Notes v2", "R&D tools", "A"]) expect([l, labelOk(l)]).toEqual([l, true]);
    for (const l of ["me@example.com", "https://x.io", "files.example.com"])
      expect(parseConnectors([{ id: "custom", label: l, state: "off", access: "read", kind: "rest" }]).ok).toBe(false);
  });
});

describe("connectors API", () => {
  let OWNER: string, MEMBER: string, OTHER: string, hub: { id: string; kp: CryptoKeyPair };
  let seq = 0, ipN = 0;
  const call = (path: string, cookie?: string, init: RequestInit = {}) => client(cookie, env()).request(path, { ...init, headers: { "cf-connecting-ip": `10.8.0.${ipN}`, ...(init.headers as Record<string, string> | undefined) } });
  async function pair(cookie: string) {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = b64encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey) as ArrayBuffer));
    const { code } = await (await call("/api/hubs/pair/start", cookie, { method: "POST" })).json() as any;
    const r = await call("/api/hubs/pair/complete", undefined, { method: "POST", body: JSON.stringify({ code, hubPublicKey: pub, edition: "mac", profile: "home", version: "1.0.0" }) });
    return { id: ((await r.json()) as any).hubId as string, kp };
  }
  async function heartbeat(h: { id: string; kp: CryptoKeyPair }, body: unknown) {
    const raw = JSON.stringify(body), ts = Math.floor(Date.now() / 1000), path = "/api/hubs/heartbeat";
    const sig = b64encode(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, h.kp.privateKey, new TextEncoder().encode(`POST\n${path}\n${ts}\n${await sha256Hex(raw)}`))));
    return call(path, undefined, { method: "POST", body: raw, headers: { "x-hub-id": h.id, "x-hub-timestamp": String(ts), "x-hub-signature": sig } });
  }
  const get = async (path: string, cookie?: string) => (await call(path, cookie)).json() as Promise<any>;

  beforeEach(async () => {
    await clearPortalTables();
    OWNER = await login(await seedOwner("cn-u1", "cn-acc1"));
    MEMBER = await login(await seedMember("cn-u3", "cn-acc1"));
    OTHER = await login(await seedOwner("cn-u2", "cn-acc2"));
    await applyEntitlement(e.DB, "cn-acc1", { plan: "estate", status: "active" }, ++seq);
    ipN++;
    hub = await pair(OWNER);
  });

  it("verified passes through heartbeat -> storage -> API; bad value is 400", async () => {
    const list = [{ id: "slack", state: "connected", access: "read", kind: "builtin", verified: false }, { id: "custom", label: "Garage sensors", state: "connected", access: "read", kind: "mcp", verified: true }];
    expect((await heartbeat(hub, hb(list))).status).toBe(200);
    const m = await get("/api/connectors", OWNER);
    expect(m.catalog.find((c: any) => c.id === "slack").hubs[0].verified).toBe(false);
    expect(m.custom[0].verified).toBe(true);
    expect((await heartbeat(hub, hb([{ id: "slack", state: "connected", access: "read", kind: "builtin", verified: "no" }]))).status).toBe(400);
  });

  it("heartbeat stores the snapshot; merged catalog shows per-hub state; custom is listed separately", async () => {
    expect((await heartbeat(hub, hb(good()))).status).toBe(200);
    const m = await get("/api/connectors", OWNER);
    expect(m.catalog).toHaveLength(CATALOG.length);
    expect(m.categories).toEqual(CATEGORIES);
    expect(m.hubs).toEqual([expect.objectContaining({ id: hub.id, online: true, reported: true })]);
    const byId = (id: string) => m.catalog.find((c: any) => c.id === id);
    expect(byId("home_assistant").hubs).toEqual([{ hubId: hub.id, state: "connected", access: "write", kind: "builtin", last_used_h: 3 }]);
    expect(byId("slack").hubs[0]).toMatchObject({ state: "needs_attention", access: "read" });
    expect(byId("philips_hue").hubs).toEqual([]);
    expect(m.custom).toEqual([{ id: "custom", label: "Garage sensors (MCP)", state: "connected", access: "read", kind: "mcp", last_used_h: 12, hubId: hub.id }]);
    // connectors are not duplicated into the stats snapshot
    expect((await get(`/api/hubs/${hub.id}`, OWNER)).hub.stats.connectors).toBeUndefined();
    expect((await get(`/api/hubs/${hub.id}`, OWNER)).hub.connectors).toHaveLength(4);
  });

  it("an omitted array keeps the last snapshot; an empty array clears it; a bad array is a 400 and changes nothing", async () => {
    await heartbeat(hub, hb(good()));
    expect((await heartbeat(hub, hb())).status).toBe(200);
    expect((await get("/api/connectors", OWNER)).catalog.find((c: any) => c.id === "slack").hubs).toHaveLength(1);
    expect((await heartbeat(hub, hb([{ id: "slack", state: "connected", access: "read", kind: "builtin", url: "https://x.example" }]))).status).toBe(400);
    expect((await heartbeat(hub, hb([{ id: "custom", label: "me@example.com", state: "off", access: "read", kind: "rest" }]))).status).toBe(400);
    expect((await get("/api/connectors", OWNER)).catalog.find((c: any) => c.id === "slack").hubs).toHaveLength(1);
    expect((await heartbeat(hub, hb([]))).status).toBe(200);
    const m = await get("/api/connectors", OWNER);
    expect(m.catalog.every((c: any) => c.hubs.length === 0)).toBe(true);
    expect(m.hubs[0].reported).toBe(true);
  });

  it("authz: owner and member read their account; other accounts see nothing of it; anonymous is 401; no write route exists", async () => {
    await heartbeat(hub, hb(good()));
    expect((await call("/api/connectors", OWNER)).status).toBe(200);
    expect((await get("/api/connectors", MEMBER)).catalog.find((c: any) => c.id === "slack").hubs).toHaveLength(1);
    const other = await get("/api/connectors", OTHER);
    expect(other.hubs).toEqual([]);
    expect(JSON.stringify(other)).not.toContain(hub.id);
    expect(other.custom).toEqual([]);
    expect((await call("/api/connectors")).status).toBe(401);
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect([m, [404, 405].includes((await call("/api/connectors", OWNER, { method: m, body: "{}" })).status)]).toEqual([m, true]);
    expect((await call(`/api/hubs/${hub.id}`, OTHER)).status).toBe(404);
  });

  it("staff read any account's connectors read-only and audited; customers and anonymous are refused", async () => {
    await heartbeat(hub, hb(good()));
    const jwt = await new SignJWT({ email: ADMIN }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`https://${TEAM}`).setAudience(AUD).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
    const staff = (path: string, init: RequestInit = {}, token: string | null = jwt) => app.request(ORIGIN + path, { ...init, headers: token ? { "Cf-Access-Jwt-Assertion": token } : {}, redirect: "manual" }, env());
    const r = await staff("/api/support/accounts/cn-acc1/connectors");
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.catalog.find((c: any) => c.id === "home_assistant").hubs[0].state).toBe("connected");
    expect(body.custom).toHaveLength(1);
    expect((await staff("/api/support/accounts/nope/connectors")).status).toBe(404);
    expect((await staff("/api/support/accounts/cn-acc1/connectors", {}, null)).status).toBe(403);
    expect((await call("/api/support/accounts/cn-acc1/connectors", OWNER)).status).toBe(403);
    expect((await call("/api/support/accounts/cn-acc1/connectors", OTHER)).status).toBe(403);
    expect((await staff("/api/support/accounts/cn-acc1/connectors", { method: "POST", body: "{}" })).status).not.toBe(200);
    const audited = await e.DB.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'support.connectors.view' AND target = 'cn-acc1'").first<{ n: number }>();
    expect(audited!.n).toBe(1);
  });

  it("unpairing a hub removes it from the merged view", async () => {
    await heartbeat(hub, hb(good()));
    expect((await call(`/api/hubs/${hub.id}`, OWNER, { method: "DELETE" })).status).toBe(200);
    expect((await get("/api/connectors", OWNER)).hubs).toEqual([]);
  });
});
