import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mount, PAIR_RATE, PAIR_TTL_S } from "../src/hubs/index";
import { setStubMaxHubs, auditLog, type AppEnv } from "../src/hubs/_stubs";
import { b64encode, sha256Hex, CODE_ALPHABET } from "../src/hubs/crypto";
import { newD1 } from "../hubs-dev/d1shim";

let db: ReturnType<typeof newD1>;
let app: Hono<AppEnv>;
const OWNER = "u1|a@x.io|owner|acc1";
const OTHER = "u2|b@x.io|owner|acc2";
const MEMBER = "u3|c@x.io|member|acc1";
let ip = 0;

beforeEach(() => {
  db = newD1();
  app = new Hono<AppEnv>();
  mount(app);
  setStubMaxHubs(2);
  auditLog.length = 0;
  ip++;
});

const call = (path: string, init: RequestInit & { user?: string; ip?: string } = {}) => {
  const h = new Headers(init.headers);
  if (init.user) h.set("x-test-user", init.user);
  if (init.method && init.method !== "GET") h.set("x-requested-with", "albena-portal");
  h.set("cf-connecting-ip", init.ip ?? `10.0.0.${ip}`);
  return app.request(`http://t${path}`, { ...init, headers: h }, { DB: db });
};
const js = (o: unknown) => JSON.stringify(o);

async function keypair() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = b64encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  return { kp, pub };
}
async function startCode(user = OWNER) {
  const r = await call("/api/hubs/pair/start", { method: "POST", user });
  return (await r.json()) as any;
}
async function pairHub() {
  const { kp, pub } = await keypair();
  const { code } = await startCode();
  const r = await call("/api/hubs/pair/complete", { method: "POST", body: js({ code, hubPublicKey: pub, edition: "mac", profile: "home", version: "1.0.0" }) });
  const { hubId } = (await r.json()) as any;
  return { kp, pub, hubId, code };
}
async function signed(hub: { kp: CryptoKeyPair; hubId: string }, path: string, body: string, opts: { ts?: number; method?: string; tamper?: boolean } = {}) {
  const method = opts.method ?? "POST";
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const msg = `${method}\n${path}\n${ts}\n${await sha256Hex(body)}`;
  const sig = b64encode(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, hub.kp.privateKey, new TextEncoder().encode(msg))));
  return {
    method, body: opts.tamper ? body + " " : body,
    headers: { "x-hub-id": hub.hubId, "x-hub-timestamp": ts, "x-hub-signature": sig },
  };
}
const hb = { version: "1.0.1", profile: "home", updateChannel: "stable", health: { ok: true, services: [["voice", "ok"]] } };

describe("pairing", () => {
  it("issues 8-char code without ambiguous chars, stores it hashed", async () => {
    const { code, expiresAt } = await startCode();
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    for (const ch of code) expect(CODE_ALPHABET).toContain(ch);
    expect("01OIL").not.toMatch(new RegExp(`[${code}]`));
    expect(expiresAt - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(PAIR_TTL_S);
    const rows = db.raw.prepare("SELECT code_hash FROM hub_pair_codes").all() as any[];
    expect(rows[0].code_hash).not.toContain(code);
  });
  it("requires a user, owner role and csrf header", async () => {
    expect((await call("/api/hubs/pair/start", { method: "POST" })).status).toBe(401);
    expect((await call("/api/hubs/pair/start", { method: "POST", user: MEMBER })).status).toBe(403);
    const r = await app.request("http://t/api/hubs/pair/start", { method: "POST", headers: { "x-test-user": OWNER } }, { DB: db });
    expect(r.status).toBe(403);
  });
  it("enforces entitlement", async () => {
    setStubMaxHubs(1);
    await pairHub();
    expect((await call("/api/hubs/pair/start", { method: "POST", user: OWNER })).status).toBe(402);
  });
  it("completes once, binds to the account, returns no token", async () => {
    const { pub } = await keypair();
    const { code } = await startCode();
    const body = js({ code: code.toLowerCase(), hubPublicKey: pub, edition: "nvidia", profile: "home", version: "1.2.3" });
    const r = await call("/api/hubs/pair/complete", { method: "POST", body });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(Object.keys(j)).toEqual(["hubId"]);
    const list = (await (await call("/api/hubs", { user: OWNER })).json()) as any;
    expect(list.hubs).toHaveLength(1);
    // reuse
    const r2 = await call("/api/hubs/pair/complete", { method: "POST", body });
    expect(r2.status).toBe(400);
  });
  it("rejects expired codes", async () => {
    const { code } = await startCode();
    db.raw.prepare("UPDATE hub_pair_codes SET expires_at = expires_at - 1000").run();
    const { pub } = await keypair();
    const r = await call("/api/hubs/pair/complete", { method: "POST", body: js({ code, hubPublicKey: pub, edition: "mac", profile: "home", version: "1.0.0" }) });
    expect(r.status).toBe(400);
  });
  it("rate limits pair/complete per IP", async () => {
    const { pub } = await keypair();
    const body = js({ code: "AAAAAAAA", hubPublicKey: pub, edition: "mac", profile: "home", version: "1.0.0" });
    let last = 0;
    for (let i = 0; i < PAIR_RATE.limit + 1; i++) last = (await call("/api/hubs/pair/complete", { method: "POST", body })).status;
    expect(last).toBe(429);
    // another IP unaffected
    expect((await call("/api/hubs/pair/complete", { method: "POST", body, ip: "9.9.9.9" })).status).toBe(400);
  });
  it("rejects bad keys and extra fields", async () => {
    const { code } = await startCode();
    const bad = await call("/api/hubs/pair/complete", { method: "POST", body: js({ code, hubPublicKey: "AAAA", edition: "mac", profile: "home", version: "1.0.0" }) });
    expect(bad.status).toBe(400);
    const extra = await call("/api/hubs/pair/complete", { method: "POST", body: js({ code, hubPublicKey: "x", edition: "mac", profile: "h", version: "1.0.0", owner: "me" }) });
    expect(extra.status).toBe(400);
  });
});

describe("signed requests", () => {
  const P = "/api/hubs/heartbeat";
  it("accepts a valid signature and returns server-side settings", async () => {
    const hub = await pairHub();
    const s = await signed(hub, P, js(hb));
    const r = await call(P, s);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, updateChannel: "stable", remoteAccess: false });
  });
  it("rejects invalid signature, tampered body, unknown hub", async () => {
    const hub = await pairHub();
    expect((await call(P, await signed(hub, P, js(hb), { tamper: true }))).status).toBe(401);
    const other = await keypair();
    expect((await call(P, await signed({ kp: other.kp, hubId: hub.hubId }, P, js(hb)))).status).toBe(401);
    expect((await call(P, await signed({ kp: hub.kp, hubId: "nope" }, P, js(hb)))).status).toBe(401);
    expect((await call(P, { method: "POST", body: js(hb) })).status).toBe(401);
  });
  it("rejects replay of the same request", async () => {
    const hub = await pairHub();
    const s = await signed(hub, P, js(hb));
    expect((await call(P, s)).status).toBe(200);
    const r = await call(P, s);
    expect(r.status).toBe(401);
    expect(((await r.json()) as any).error).toBe("replay");
  });
  it("rejects clock skew beyond 5 minutes, accepts within", async () => {
    const hub = await pairHub();
    const t = Math.floor(Date.now() / 1000);
    expect((await call(P, await signed(hub, P, js(hb), { ts: t - 301 }))).status).toBe(401);
    expect((await call(P, await signed(hub, P, js(hb), { ts: t + 301 }))).status).toBe(401);
    expect((await call(P, await signed(hub, P, js(hb), { ts: t - 200 }))).status).toBe(200);
  });
  it("signature does not transfer to another path", async () => {
    const hub = await pairHub();
    const s = await signed(hub, "/api/hubs/other", js(hb));
    expect((await call(P, s)).status).toBe(401);
  });
  it("revoked (unpaired) hub can no longer authenticate", async () => {
    const hub = await pairHub();
    expect((await call(`/api/hubs/${hub.hubId}`, { method: "DELETE", user: OWNER })).status).toBe(200);
    expect((await call(P, await signed(hub, P, js(hb)))).status).toBe(401);
    expect(auditLog.map((a) => a.action)).toContain("hub.unpair");
  });
});

describe("heartbeat schema", () => {
  const P = "/api/hubs/heartbeat";
  it("rejects extra/unknown fields at every level", async () => {
    const hub = await pairHub();
    const cases = [
      { ...hb, transcript: "hello" },
      { ...hb, health: { ...hb.health, ssid: "home" } },
      { ...hb, health: { ok: true, services: [["voice", "ok", "extra"]] } },
      { ...hb, health: { ok: true, services: [["voice", "weird"]] } },
      { ...hb, health: { ok: true, services: [["has spaces & pii", "ok"]] } },
      { ...hb, updateChannel: "nightly" },
    ];
    for (const c of cases) expect((await call(P, await signed(hub, P, js(c)))).status).toBe(400);
  });
  it("caps body at 4KB", async () => {
    const hub = await pairHub();
    const big = js({ ...hb, version: "1.0.0" }) + " ".repeat(5000);
    expect((await call(P, await signed(hub, P, big))).status).toBe(413);
  });
  it("stores metadata and shows it to the owner only", async () => {
    const hub = await pairHub();
    await call(P, await signed(hub, P, js(hb)));
    const mine = (await (await call("/api/hubs", { user: OWNER })).json()) as any;
    expect(mine.hubs[0].version).toBe("1.0.1");
    expect(mine.hubs[0].health.ok).toBe(true);
    expect(mine.hubs[0].lastSeen).toBeGreaterThan(0);
    expect(((await (await call("/api/hubs", { user: OTHER })).json()) as any).hubs).toHaveLength(0);
  });
});

describe("hub management", () => {
  it("remoteAccess defaults to false and updateChannel to stable", async () => {
    const hub = await pairHub();
    const h = ((await (await call("/api/hubs", { user: OWNER })).json()) as any).hubs[0];
    expect(h.remoteAccess).toBe(false);
    expect(h.updateChannel).toBe("stable");
    expect(h.id).toBe(hub.hubId);
  });
  it("PATCH updates own hub, validates input, audits", async () => {
    const hub = await pairHub();
    const r = await call(`/api/hubs/${hub.hubId}`, { method: "PATCH", user: OWNER, body: js({ name: "Kitchen", updateChannel: "beta", remoteAccess: true }) });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).hub).toMatchObject({ name: "Kitchen", updateChannel: "beta", remoteAccess: true });
    expect((await call(`/api/hubs/${hub.hubId}`, { method: "PATCH", user: OWNER, body: js({ updateChannel: "x" }) })).status).toBe(400);
    expect((await call(`/api/hubs/${hub.hubId}`, { method: "PATCH", user: OWNER, body: js({ remoteAccess: "yes" }) })).status).toBe(400);
    expect((await call(`/api/hubs/${hub.hubId}`, { method: "PATCH", user: OWNER, body: js({ owner: "x" }) })).status).toBe(400);
    expect(auditLog.some((a) => a.action === "hub.update")).toBe(true);
  });
  it("cannot PATCH or DELETE another account's hub; members cannot mutate", async () => {
    const hub = await pairHub();
    expect((await call(`/api/hubs/${hub.hubId}`, { method: "PATCH", user: OTHER, body: js({ remoteAccess: true }) })).status).toBe(404);
    expect((await call(`/api/hubs/${hub.hubId}`, { method: "DELETE", user: OTHER })).status).toBe(404);
    expect((await call(`/api/hubs/${hub.hubId}`, { method: "PATCH", user: MEMBER, body: js({ name: "x" }) })).status).toBe(403);
    const h = ((await (await call("/api/hubs", { user: OWNER })).json()) as any).hubs[0];
    expect(h.remoteAccess).toBe(false);
  });
  it("heartbeat reflects PATCHed settings", async () => {
    const hub = await pairHub();
    await call(`/api/hubs/${hub.hubId}`, { method: "PATCH", user: OWNER, body: js({ remoteAccess: true, updateChannel: "beta" }) });
    const P = "/api/hubs/heartbeat";
    const r = await call(P, await signed(hub, P, js(hb)));
    expect(await r.json()).toEqual({ ok: true, updateChannel: "beta", remoteAccess: true });
  });
});

describe("releases", () => {
  const add = (edition: string, channel: string, version: string, at: number) =>
    db.raw.prepare("INSERT INTO releases(edition,channel,version,manifest_url,signature_url,signature,sha256,released_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(edition, channel, version, `https://d/${version}/manifest.json`, `https://d/${version}/manifest.json.sig`, "SIG", "a".repeat(64), at);
  it("returns latest per edition/channel; stable never sees beta", async () => {
    add("mac", "stable", "1.0.0", 100); add("mac", "beta", "1.1.0-b1", 200); add("nvidia", "stable", "0.9.0", 50);
    const s = (await (await call("/api/releases/latest?edition=mac")).json()) as any;
    expect(s).toMatchObject({ version: "1.0.0", manifestUrl: "https://d/1.0.0/manifest.json", signature: "SIG", sha256: "a".repeat(64) });
    const b = (await (await call("/api/releases/latest?edition=mac&channel=beta")).json()) as any;
    expect(b.version).toBe("1.1.0-b1");
    expect(((await (await call("/api/releases/latest?edition=nvidia")).json()) as any).version).toBe("0.9.0");
  });
  it("validates params and 404s when empty", async () => {
    expect((await call("/api/releases/latest?edition=pc")).status).toBe(400);
    expect((await call("/api/releases/latest?edition=mac&channel=x")).status).toBe(400);
    expect((await call("/api/releases/latest?edition=mac")).status).toBe(404);
  });
});
