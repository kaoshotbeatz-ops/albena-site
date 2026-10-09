import type { Context, Hono } from "hono";
import type { AppEnv } from "../types";
import { audit, requireUser } from "../auth";
import { getEntitlement } from "../billing/entitlements";
import { MAX_BODY, CHANNELS, EDITIONS, parseHeartbeat, parseHubPatch, parsePairComplete } from "./schema";
import { b64decode, newPairCode, normalizeCode, sha256Hex, signingString, verifyEd25519 } from "./crypto";

export const migrations: string[] = ["0300_hubs_init.sql"];

export const PAIR_TTL_S = 600;
export const SKEW_S = 300;
export const PAIR_RATE = { limit: 10, windowS: 60 }; // per client IP
export const PAIR_FAIL_RATE = { limit: 20, windowS: 600 }; // failed codes per IP

const now = () => Math.floor(Date.now() / 1000);
type C = Context<AppEnv>;
const CSRF = (c: C) => c.req.header("x-requested-with") === "albena-portal";

async function pepper(c: C, code: string) {
  return sha256Hex(`${c.env.PORTAL_SECRETS}|paircode|${code}`);
}

/** Fixed-window counter in D1. Returns true if the call is allowed. */
async function rateOk(c: C, bucket: string, rule: { limit: number; windowS: number }, consume = true): Promise<boolean> {
  const t = now();
  const row = await c.env.DB.prepare("SELECT window_start, count FROM hub_rate WHERE bucket=?").bind(bucket).first<{ window_start: number; count: number }>();
  if (!row || t - row.window_start >= rule.windowS) {
    if (consume) await c.env.DB.prepare("INSERT OR REPLACE INTO hub_rate(bucket,window_start,count) VALUES(?,?,1)").bind(bucket, t).run();
    return true;
  }
  if (row.count >= rule.limit) return false;
  if (consume) await c.env.DB.prepare("UPDATE hub_rate SET count=count+1 WHERE bucket=?").bind(bucket).run();
  return true;
}

async function readBody(c: C): Promise<{ raw: Uint8Array; json: unknown } | Response> {
  const raw = new Uint8Array(await c.req.raw.arrayBuffer());
  if (raw.length > MAX_BODY) return c.json({ error: "body too large" }, 413);
  try {
    return { raw, json: raw.length ? JSON.parse(new TextDecoder().decode(raw)) : {} };
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
}

/** Verifies X-Hub-* headers. Returns the hub row, or a Response on failure. */
async function verifyHub(c: C, raw: Uint8Array): Promise<any | Response> {
  const id = c.req.header("x-hub-id") ?? "";
  const ts = c.req.header("x-hub-timestamp") ?? "";
  const sig = c.req.header("x-hub-signature") ?? "";
  const fail = () => c.json({ error: "invalid signature" }, 401);
  if (!id || !/^\d{9,12}$/.test(ts) || !sig || sig.length > 128) return fail();
  if (Math.abs(now() - Number(ts)) > SKEW_S) return c.json({ error: "timestamp out of range" }, 401);
  const hub = await c.env.DB.prepare("SELECT * FROM hubs WHERE id=?").bind(id).first<any>();
  if (!hub) return fail();
  const url = new URL(c.req.url);
  const msg = await signingString(c.req.method, url.pathname + url.search, ts, raw);
  if (!(await verifyEd25519(hub.public_key, sig, msg))) return fail();
  // replay: a valid signature may be seen only once inside the window
  const t = now();
  await c.env.DB.prepare("DELETE FROM hub_nonces WHERE expires_at < ?").bind(t).run();
  const sh = await sha256Hex(sig);
  const ins = await c.env.DB.prepare("INSERT OR IGNORE INTO hub_nonces(hub_id,sig_hash,expires_at) VALUES(?,?,?)").bind(id, sh, t + SKEW_S * 2).run();
  if (!ins.meta?.changes) return c.json({ error: "replay" }, 401);
  return hub;
}

const publicHub = (h: any) => ({
  id: h.id, name: h.name, edition: h.edition, profile: h.profile, version: h.version,
  updateChannel: h.update_channel, remoteAccess: !!h.remote_access,
  health: h.health_json ? JSON.parse(h.health_json) : null, lastSeen: h.last_seen, createdAt: h.created_at,
});

export function mount(app: Hono<AppEnv>): void {
  // ---- user-facing ----
  app.post("/api/hubs/pair/start", requireUser, async (c) => {
    const u = c.get("user");
    if (!CSRF(c)) return c.json({ error: "csrf" }, 403);
    if (u.role !== "owner") return c.json({ error: "forbidden" }, 403);
    const { maxHubs } = await getEntitlement(c.env.DB, u.accountId);
    const n = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM hubs WHERE account_id=?").bind(u.accountId).first<{ n: number }>())!.n;
    if (n >= maxHubs) return c.json({ error: "plan does not allow another hub" }, 402);
    const code = newPairCode();
    const t = now();
    await c.env.DB.prepare("INSERT INTO hub_pair_codes(code_hash,account_id,user_id,expires_at,created_at) VALUES(?,?,?,?,?)")
      .bind(await pepper(c, code), u.accountId, u.id, t + PAIR_TTL_S, t).run();
    await audit(c, "hub.pair.start", u.accountId);
    return c.json({ code, expiresAt: t + PAIR_TTL_S });
  });

  app.post("/api/hubs/pair/complete", async (c) => {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (!(await rateOk(c, `pair:${ip}`, PAIR_RATE)) || !(await rateOk(c, `pairfail:${ip}`, PAIR_FAIL_RATE, false)))
      return c.json({ error: "rate limited" }, 429);
    const body = await readBody(c);
    if (body instanceof Response) return body;
    const p = parsePairComplete(body.json);
    if (!p.ok) return c.json({ error: p.error }, 400);
    const code = normalizeCode(p.value.code);
    const pub = b64decode(p.value.hubPublicKey);
    if (!code || !pub || pub.length !== 32) return c.json({ error: "invalid request" }, 400);
    const bad = async () => {
      await rateOk(c, `pairfail:${ip}`, PAIR_FAIL_RATE);
      return c.json({ error: "invalid or expired code" }, 400);
    };
    const t = now();
    const hash = await pepper(c, code);
    // atomic single-use claim
    const claim = await c.env.DB.prepare("UPDATE hub_pair_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL AND expires_at>=?").bind(t, hash, t).run();
    if (!claim.meta?.changes) return bad();
    const row = (await c.env.DB.prepare("SELECT account_id FROM hub_pair_codes WHERE code_hash=?").bind(hash).first<{ account_id: string }>())!;
    const hubId = crypto.randomUUID();
    try {
      await c.env.DB.prepare("INSERT INTO hubs(id,account_id,public_key,edition,profile,version,created_at) VALUES(?,?,?,?,?,?,?)")
        .bind(hubId, row.account_id, p.value.hubPublicKey, p.value.edition, p.value.profile, p.value.version, t).run();
    } catch {
      return c.json({ error: "hub key already registered" }, 409);
    }
    await audit(c, "hub.pair.complete", hubId, { accountId: row.account_id, edition: p.value.edition });
    return c.json({ hubId });
  });

  app.get("/api/hubs", requireUser, async (c) => {
    const u = c.get("user");
    const r = await c.env.DB.prepare("SELECT * FROM hubs WHERE account_id=? ORDER BY created_at").bind(u.accountId).all();
    return c.json({ hubs: (r.results ?? []).map(publicHub) });
  });

  app.patch("/api/hubs/:id", requireUser, async (c) => {
    const u = c.get("user");
    if (!CSRF(c)) return c.json({ error: "csrf" }, 403);
    if (u.role !== "owner") return c.json({ error: "forbidden" }, 403);
    const body = await readBody(c);
    if (body instanceof Response) return body;
    const p = parseHubPatch(body.json);
    if (!p.ok) return c.json({ error: p.error }, 400);
    const v = p.value;
    const r = await c.env.DB.prepare(
      "UPDATE hubs SET name=COALESCE(?,name), update_channel=COALESCE(?,update_channel), remote_access=COALESCE(?,remote_access) WHERE id=? AND account_id=?",
    ).bind(v.name ?? null, v.updateChannel ?? null, v.remoteAccess === undefined ? null : v.remoteAccess ? 1 : 0, c.req.param("id"), u.accountId).run();
    if (!r.meta?.changes) return c.json({ error: "not found" }, 404); // same answer for other accounts' hubs
    await audit(c, "hub.update", c.req.param("id"), v as Record<string, unknown>);
    const h = await c.env.DB.prepare("SELECT * FROM hubs WHERE id=?").bind(c.req.param("id")).first();
    return c.json({ hub: publicHub(h) });
  });

  app.delete("/api/hubs/:id", requireUser, async (c) => {
    const u = c.get("user");
    if (!CSRF(c)) return c.json({ error: "csrf" }, 403);
    if (u.role !== "owner") return c.json({ error: "forbidden" }, 403);
    const id = c.req.param("id");
    const r = await c.env.DB.prepare("DELETE FROM hubs WHERE id=? AND account_id=?").bind(id, u.accountId).run();
    if (!r.meta?.changes) return c.json({ error: "not found" }, 404);
    await c.env.DB.prepare("DELETE FROM hub_nonces WHERE hub_id=?").bind(id).run();
    await audit(c, "hub.unpair", id);
    return c.json({ ok: true });
  });

  // ---- hub-facing (signed) ----
  app.post("/api/hubs/heartbeat", async (c) => {
    const body = await readBody(c);
    if (body instanceof Response) return body;
    const hub = await verifyHub(c, body.raw);
    if (hub instanceof Response) return hub;
    const p = parseHeartbeat(body.json);
    if (!p.ok) return c.json({ error: p.error }, 400);
    const v = p.value;
    await c.env.DB.prepare("UPDATE hubs SET version=?, profile=?, health_ok=?, health_json=?, last_seen=? WHERE id=?")
      .bind(v.version, v.profile, v.health.ok ? 1 : 0, JSON.stringify(v.health), now(), hub.id).run();
    // server-side settings win; hub learns them here
    return c.json({ ok: true, updateChannel: hub.update_channel, remoteAccess: !!hub.remote_access });
  });

  // ---- releases (public, no personal data) ----
  app.get("/api/releases/latest", async (c) => {
    const edition = c.req.query("edition") ?? "";
    const channel = c.req.query("channel") ?? "stable";
    if (!(EDITIONS as readonly string[]).includes(edition) || !(CHANNELS as readonly string[]).includes(channel))
      return c.json({ error: "bad edition or channel" }, 400);
    // stable users never see beta; beta users get the newer of beta/stable
    const channels = channel === "beta" ? ["beta", "stable"] : ["stable"];
    const rows = (await c.env.DB.prepare(
      `SELECT * FROM releases WHERE edition=? AND channel IN (${channels.map(() => "?").join(",")}) ORDER BY released_at DESC, id DESC LIMIT 1`,
    ).bind(edition, ...channels).all()).results ?? [];
    const r = rows[0];
    if (!r) return c.json({ error: "no release" }, 404);
    return c.json({
      edition: r.edition, channel: r.channel, version: r.version,
      manifestUrl: r.manifest_url, signatureUrl: r.signature_url, signature: r.signature, signatureScheme: r.sig_scheme,
      namespace: "albena-hub-release", sha256: r.sha256, releasedAt: r.released_at,
    });
  });
}
