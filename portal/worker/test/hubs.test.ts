import { beforeEach, describe, expect, it } from "vitest";
import { PAIR_FAIL_RATE, PAIR_RATE, PAIR_TTL_S, rateHit } from "../src/hubs/index";
import { applyEntitlement } from "../src/billing/entitlements";
import { b64decodeStrict, b64encode, sha256Hex, CODE_ALPHABET } from "../src/hubs/crypto";
import { app } from "../src/index";
import { ORIGIN, auditSince, clearPortalTables, client, e, lastAuditId, login, seedMember, seedOwner, testBindings } from "./helpers";

let db: D1Database;
let OWNER: string, OTHER: string, MEMBER: string; // session cookies
let env: ReturnType<typeof testBindings>;
let ip = 0;
let auditMark = 0;

let seq = 0;
const setMaxHubs = (n: number) => applyEntitlement(db, "acc1", { plan: n > 1 ? "estate" : "byo", status: "active" }, ++seq);
const auditActions = async () => (await auditSince(auditMark)).map((a) => a.action);

beforeEach(async () => {
  db = e.DB; env = testBindings();
  await clearPortalTables();
  OWNER = await login(await seedOwner("u1", "acc1"));
  OTHER = await login(await seedOwner("u2", "acc2"));
  MEMBER = await login(await seedMember("u3", "acc1"));
  await setMaxHubs(2);
  auditMark = await lastAuditId();
  ip++;
});

const call = (path: string, init: RequestInit & { user?: string; ip?: string } = {}) => {
  const h = new Headers(init.headers);
  h.set("cf-connecting-ip", init.ip ?? `10.0.0.${ip}`);
  return client(init.user, env).request(path, { ...init, headers: Object.fromEntries(h) });
};
const js = (o: unknown) => JSON.stringify(o);

async function keypair() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = b64encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey) as ArrayBuffer));
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
    const rows = (await db.prepare("SELECT code_hash FROM hub_pair_codes").all()).results as any[];
    expect(rows[0].code_hash).not.toContain(code);
  });
  it("requires a user, owner role and csrf header", async () => {
    expect((await call("/api/hubs/pair/start", { method: "POST" })).status).toBe(401);
    expect((await call("/api/hubs/pair/start", { method: "POST", user: MEMBER })).status).toBe(403);
    const r = await app.request(ORIGIN + "/api/hubs/pair/start", { method: "POST", headers: { Cookie: OWNER } }, env);
    expect(r.status).toBe(403);
  });
  it("enforces entitlement", async () => {
    await setMaxHubs(1);
    await pairHub();
    expect((await call("/api/hubs/pair/start", { method: "POST", user: OWNER })).status).toBe(402);
  });
  it("refuses pairing without an active entitlement", async () => {
    await db.prepare("DELETE FROM entitlements").run();
    expect((await call("/api/hubs/pair/start", { method: "POST", user: OWNER })).status).toBe(402);
    await applyEntitlement(db, "acc1", { plan: "hub_mac", status: "past_due" }, ++seq);
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
    await db.prepare("UPDATE hub_pair_codes SET expires_at = expires_at - 1000").run();
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
    expect(await auditActions()).toContain("hub.unpair");
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
  it("caps body at 16KB", async () => {
    const hub = await pairHub();
    const big = js({ ...hb, version: "1.0.0" }) + " ".repeat(17000);
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
    expect(await auditActions()).toContain("hub.update");
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
    db.prepare("INSERT INTO releases(edition,channel,version,manifest_url,signature_url,signature,sha256,released_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(edition, channel, version, `https://d/${version}/manifest.json`, `https://d/${version}/manifest.json.sig`, "SIG", "a".repeat(64), at).run();
  it("returns latest per edition/channel; stable never sees beta", async () => {
    await add("mac", "stable", "1.0.0", 100); await add("mac", "beta", "1.1.0-b1", 200); await add("nvidia", "stable", "0.9.0", 50);
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

const completeBody = (code: string, pub: string, extra: object = {}) => js({ code, hubPublicKey: pub, edition: "mac", profile: "home", version: "1.0.0", ...extra });
const hubCount = async (acct = "acc1") => (await db.prepare("SELECT COUNT(*) n FROM hubs WHERE account_id=?").bind(acct).first<any>()).n;

describe("[1] hub quota is enforced atomically at pair/complete", () => {
  it("many outstanding codes on a one-hub plan yield exactly one hub", async () => {
    await setMaxHubs(1);
    // /pair/start only checks a free slot, so both codes can be issued before either is redeemed
    const codes = [(await startCode()).code, (await startCode()).code];
    const first = (await keypair()).pub, second = (await keypair()).pub;
    expect((await call("/api/hubs/pair/complete", { method: "POST", body: completeBody(codes[0], first) })).status).toBe(200);
    const r = await call("/api/hubs/pair/complete", { method: "POST", body: completeBody(codes[1], second) });
    expect(r.status).toBe(402);
    expect(await hubCount()).toBe(1);
    expect((await db.prepare("SELECT used_at FROM hub_pair_codes WHERE used_at IS NULL").all()).results).toHaveLength(1); // refused code was not burned
  });
  it("concurrent redemptions cannot exceed the plan", async () => {
    await setMaxHubs(1);
    const codes = [(await startCode()).code, (await startCode()).code, (await startCode()).code];
    const rs = await Promise.all(codes.map(async (code, i) => call("/api/hubs/pair/complete", { method: "POST", ip: `7.7.7.${i}`, body: completeBody(code, (await keypair()).pub) })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 402)).toHaveLength(2);
    expect(await hubCount()).toBe(1);
  });
  it("a code issued while active cannot be redeemed after the entitlement is lost", async () => {
    const { code } = await startCode();
    await applyEntitlement(db, "acc1", { plan: "byo", status: "canceled" }, ++seq);
    const r = await call("/api/hubs/pair/complete", { method: "POST", body: completeBody(code, (await keypair()).pub) });
    expect(r.status).toBe(402);
    expect(await hubCount()).toBe(0);
    await applyEntitlement(db, "acc1", { plan: "byo", status: "past_due" }, ++seq);
    expect((await call("/api/hubs/pair/complete", { method: "POST", body: completeBody(code, (await keypair()).pub) })).status).toBe(402);
  });
  it("estate plan allows its five hubs and no more", async () => {
    await setMaxHubs(5);
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) codes.push((await startCode()).code);
    for (const c of codes) expect((await call("/api/hubs/pair/complete", { method: "POST", body: completeBody(c, (await keypair()).pub) })).status).toBe(200);
    expect(await hubCount()).toBe(5);
    expect((await call("/api/hubs/pair/start", { method: "POST", user: OWNER })).status).toBe(402);
  });
  it("a duplicate hub key is refused without burning the code", async () => {
    const a = await pairHub();
    await setMaxHubs(3);
    const { code } = await startCode();
    const r = await call("/api/hubs/pair/complete", { method: "POST", body: completeBody(code, a.pub) });
    expect(r.status).toBe(409);
    expect(await hubCount()).toBe(1);
    expect((await call("/api/hubs/pair/complete", { method: "POST", body: completeBody(code, (await keypair()).pub) })).status).toBe(200);
  });
});

describe("[6] canonical base64 for keys and signatures", () => {
  const P = "/api/hubs/heartbeat";
  it("strict decoder accepts only the canonical spelling", () => {
    const bytes = new Uint8Array(64).map((_, i) => [0xfb, 0xef, 0xbe, 0xff, 0xff, 0xff][i % 6]); // encodes to + and /
    const good = b64encode(bytes);
    expect(b64decodeStrict(good)).toEqual(bytes);
    expect(b64decodeStrict(good.replace(/=+$/, ""))).toBeNull();
    expect(b64decodeStrict(good.slice(0, 10) + " " + good.slice(10))).toBeNull();
    expect(b64decodeStrict(good + "\n")).toBeNull();
    expect(b64decodeStrict(good.replace(/\+/g, "-").replace(/\//g, "_"))).toBeNull();
    expect(b64decodeStrict("")).toBeNull();
  });
  it("signature with stripped padding or inserted whitespace is rejected, not treated as a fresh nonce", async () => {
    const hub = await pairHub();
    const s = await signed(hub, P, js(hb));
    const sig = s.headers["x-hub-signature"];
    expect(sig.endsWith("==")).toBe(true);
    expect((await call(P, s)).status).toBe(200);
    for (const variant of [sig.replace(/=+$/, ""), sig.slice(0, 20) + " " + sig.slice(20), sig + " ", "\t" + sig]) {
      const r = await call(P, { ...s, headers: { ...s.headers, "x-hub-signature": variant } });
      expect(r.status).toBe(401);
    }
    expect((await call(P, s)).status).toBe(401); // exact replay still caught
    expect((await db.prepare("SELECT COUNT(*) n FROM hub_nonces WHERE hub_id=?").bind(hub.hubId).first<any>()).n).toBe(1);
  });
  it("replay key is the hash of the decoded signature bytes", async () => {
    const hub = await pairHub();
    const s = await signed(hub, P, js(hb));
    await call(P, s);
    const bytes = b64decodeStrict(s.headers["x-hub-signature"])!;
    const row = await db.prepare("SELECT sig_hash h FROM hub_nonces WHERE hub_id=?").bind(hub.hubId).first<any>();
    expect(row.h).toBe(await sha256Hex(bytes));
  });
  it("pairing rejects non-canonical public keys and stores the canonical form", async () => {
    const { pub } = await keypair();
    const lastIdx = pub.indexOf("=") - 1;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const bumped = pub.slice(0, lastIdx) + alphabet[(alphabet.indexOf(pub[lastIdx]) + 1) % 64] + pub.slice(lastIdx + 1); // same bytes, other spelling
    expect(atob(bumped)).toBe(atob(pub));
    for (const bad of [pub.replace(/=+$/, ""), bumped, pub + " ", " " + pub]) {
      const { code } = await startCode();
      expect((await call("/api/hubs/pair/complete", { method: "POST", ip: `8.8.${Math.floor(Math.random() * 200)}.1`, body: completeBody(code, bad) })).status).toBe(400);
    }
    const { code } = await startCode();
    expect((await call("/api/hubs/pair/complete", { method: "POST", body: completeBody(code, pub) })).status).toBe(200);
    expect((await db.prepare("SELECT public_key k FROM hubs").first<any>()).k).toBe(pub);
  });
});

describe("[11] atomic rate limits", () => {
  const rule = { limit: 10, windowS: 60 };
  it("concurrent hits admit exactly the limit", async () => {
    const rs = await Promise.all(Array.from({ length: 40 }, () => rateHit(db, "t:concurrent", rule)));
    expect(rs.filter((r) => r.ok)).toHaveLength(10);
    expect(Math.max(...rs.map((r) => r.count))).toBe(40);
  });
  it("window reset is atomic and starts a fresh count", async () => {
    await Promise.all(Array.from({ length: 12 }, () => rateHit(db, "t:reset", rule)));
    await db.prepare("UPDATE hub_rate SET window_start = window_start - 120 WHERE bucket='t:reset'").run();
    const rs = await Promise.all(Array.from({ length: 15 }, () => rateHit(db, "t:reset", rule)));
    expect(rs.filter((r) => r.ok)).toHaveLength(10); // no lost increments across the reset
  });
  it("concurrent pair/complete attempts from one IP are bounded by PAIR_RATE", async () => {
    const { pub } = await keypair();
    const rs = await Promise.all(Array.from({ length: 30 }, () => call("/api/hubs/pair/complete", { method: "POST", body: completeBody("AAAAAAAA", pub) })));
    expect(rs.filter((r) => r.status === 400)).toHaveLength(PAIR_RATE.limit);
    expect(rs.filter((r) => r.status === 429)).toHaveLength(30 - PAIR_RATE.limit);
  });
  it("the failure counter holds under concurrency and successful pairings do not spend it", async () => {
    const fr = await Promise.all(Array.from({ length: PAIR_FAIL_RATE.limit + 10 }, () => rateHit(db, "pairfail:z", PAIR_FAIL_RATE)));
    expect(fr.filter((r) => r.ok)).toHaveLength(PAIR_FAIL_RATE.limit);
    await pairHub();
    const row = await db.prepare("SELECT count FROM hub_rate WHERE bucket=?").bind(`pairfail:10.0.0.${ip}`).first<any>();
    expect(row?.count ?? 0).toBe(0);
  });
});
