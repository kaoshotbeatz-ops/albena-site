import type { Context, Hono } from "hono";
import type { AppEnv } from "../types";
import { audit, requireUser } from "../auth";
import { getEntitlement } from "../billing/entitlements";
import { MAX_HUBS } from "../billing/plans";
import { MAX_BODY, CHANNELS, EDITIONS, SERIAL, parseHeartbeat, parseHubPatch, parsePairComplete } from "./schema";
import { RANGES, type Range, isOnline, loadDetail, loadMetrics, parseStored, recordMetric, summarize } from "./stats";
import { b64decodeStrict, b64encode, newPairCode, normalizeCode, licenseKeyHash, normalizeLicenseKey, sha256Hex, signingString, verifyEd25519 } from "./crypto";

export const migrations: string[] = ["0300_hubs_init.sql", "0600_hub_stats.sql", "0700_hub_public_net.sql", "0800_hub_connectors.sql"];

export const PAIR_TTL_S = 600;
export const SKEW_S = 300;
export const PAIR_RATE = { limit: 10, windowS: 60 }; // per client IP
export const PAIR_FAIL_RATE = { limit: 20, windowS: 600 }; // failed codes per IP

/** SQL CASE giving the hub allowance per plan, generated from MAX_HUBS so the two cannot drift. */
const MAX_HUBS_SQL = `COALESCE(e.max_hubs, CASE e.plan ${Object.entries(MAX_HUBS).map(([plan, n]) => `WHEN '${plan}' THEN ${Number(n)}`).join(" ")} ELSE 0 END)`;
/** True when the account's entitlement is live (active/trialing, not past a manual end date) and it has a free Hub slot. */
const entitledSql = (acct: string, t: string) =>
  `EXISTS (SELECT 1 FROM entitlements e WHERE e.account_id = ${acct} AND e.status IN ('active','trialing') AND (e.ends_at IS NULL OR e.ends_at > ${t})
     AND (SELECT COUNT(*) FROM hubs h WHERE h.account_id = ${acct}) < ${MAX_HUBS_SQL})`;

const now = () => Math.floor(Date.now() / 1000);
type C = Context<AppEnv>;
const CSRF = (c: C) => c.req.header("x-requested-with") === "albena-portal";

async function pepper(c: C, code: string) {
  return sha256Hex(`${c.env.PORTAL_SECRETS}|paircode|${code}`);
}

/**
 * Fixed-window counter in ONE atomic UPSERT ... RETURNING (no read-then-write). Every call counts, including
 * denied ones, and the window never extends. Returns the count including this call; allowed iff count <= limit.
 */
export async function rateHit(db: D1Database, bucket: string, rule: { limit: number; windowS: number }): Promise<{ ok: boolean; count: number }> {
  const row = await db.prepare(
    `INSERT INTO hub_rate(bucket, window_start, count) VALUES(?1, ?2, 1)
     ON CONFLICT(bucket) DO UPDATE SET
       window_start = CASE WHEN ?2 - hub_rate.window_start >= ?3 THEN ?2 ELSE hub_rate.window_start END,
       count = CASE WHEN ?2 - hub_rate.window_start >= ?3 THEN 1 ELSE hub_rate.count + 1 END
     RETURNING count`,
  ).bind(bucket, now(), rule.windowS).first<{ count: number }>();
  const count = row?.count ?? rule.limit + 1;
  return { ok: count <= rule.limit, count };
}

/** Gives back a slot taken by rateHit (same window only). */
async function rateRefund(db: D1Database, bucket: string, rule: { windowS: number }): Promise<void> {
  await db.prepare("UPDATE hub_rate SET count = count - 1 WHERE bucket = ? AND count > 0 AND ? - window_start < ?").bind(bucket, now(), rule.windowS).run();
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
  const sigBytes = b64decodeStrict(sig); // one spelling per signature, so the replay key below cannot be dodged
  if (!sigBytes) return fail();
  const hub = await c.env.DB.prepare("SELECT * FROM hubs WHERE id=?").bind(id).first<any>();
  if (!hub) return fail();
  const url = new URL(c.req.url);
  const msg = await signingString(c.req.method, url.pathname + url.search, ts, raw);
  if (!(await verifyEd25519(hub.public_key, sig, msg))) return fail();
  // replay: a valid signature may be seen only once inside the window
  const t = now();
  await c.env.DB.prepare("DELETE FROM hub_nonces WHERE expires_at < ?").bind(t).run();
  const sh = await sha256Hex(sigBytes);
  const ins = await c.env.DB.prepare("INSERT OR IGNORE INTO hub_nonces(hub_id,sig_hash,expires_at) VALUES(?,?,?)").bind(id, sh, t + SKEW_S * 2).run();
  if (!ins.meta?.changes) return c.json({ error: "replay" }, 401);
  return hub;
}

const publicHub = (h: any) => ({
  id: h.id, name: h.name, edition: h.edition, profile: h.profile, version: h.version,
  updateChannel: h.update_channel, remoteAccess: !!h.remote_access,
  health: h.health_json ? JSON.parse(h.health_json) : null, lastSeen: h.last_seen, createdAt: h.created_at,
  online: isOnline(h.last_seen), summary: summarize(parseStored(h.stats_json)),
});

/** Public network info for the heartbeat's caller, from Cloudflare (CF-Connecting-IP and request.cf). Null when there is no usable IP. */
function publicNet(c: C) {
  const ip = (c.req.header("cf-connecting-ip") ?? "").trim().slice(0, 45);
  if (!ip) return null;
  const cf = ((c.req.raw as { cf?: Record<string, unknown> }).cf ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 100) : null);
  const asn = typeof cf.asn === "number" && Number.isInteger(cf.asn) ? cf.asn : null;
  return { ip, isp: str(cf.asOrganization), asn, city: str(cf.city), region: str(cf.region), country: str(cf.country), tz: str(cf.timezone) };
}

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
    const db = c.env.DB;
    if (!(await rateHit(db, `pair:${ip}`, PAIR_RATE)).ok) return c.json({ error: "rate limited" }, 429);
    // Reserve a failure slot up front (atomic); it is given back below if the attempt succeeds.
    if (!(await rateHit(db, `pairfail:${ip}`, PAIR_FAIL_RATE)).ok) return c.json({ error: "rate limited" }, 429);
    let success = false;
    try {
      const body = await readBody(c);
      if (body instanceof Response) return body;
      const p = parsePairComplete(body.json);
      if (!p.ok) return c.json({ error: p.error }, 400);
      const pub = b64decodeStrict(p.value.hubPublicKey);
      if (!pub || pub.length !== 32) return c.json({ error: "invalid request" }, 400);
      const publicKey = b64encode(pub); // canonical spelling is what gets stored and what the UNIQUE index sees
      const t = now();
      const hubId = crypto.randomUUID();
      const { edition, profile, version } = p.value;
      // One transaction: the hub is inserted only if the credential is live AND the account's entitlement is active AND
      // it still has a free slot; the credential is consumed (code, serial) or counted (license key) only if that insert happened.
      let insert: D1PreparedStatement, consume: D1PreparedStatement, live: D1PreparedStatement, via: "code" | "serial" | "license_key";
      const head = `INSERT INTO hubs(id,account_id,name,public_key,edition,profile,version,created_at)`;
      if (p.value.code !== undefined) {
        const code = normalizeCode(p.value.code);
        if (!code) return c.json({ error: "invalid request" }, 400);
        const hash = await pepper(c, code);
        via = "code";
        insert = db.prepare(
          `${head} SELECT ?1, pc.account_id, 'My Hub', ?2, ?3, ?4, ?5, ?6 FROM hub_pair_codes pc
           WHERE pc.code_hash = ?7 AND pc.used_at IS NULL AND pc.expires_at >= ?6 AND ${entitledSql("pc.account_id", "?6")}`,
        ).bind(hubId, publicKey, edition, profile, version, t, hash);
        consume = db.prepare("UPDATE hub_pair_codes SET used_at=?1 WHERE code_hash=?2 AND used_at IS NULL AND EXISTS (SELECT 1 FROM hubs WHERE id=?3)").bind(t, hash, hubId);
        live = db.prepare("SELECT 1 AS x FROM hub_pair_codes WHERE code_hash=? AND used_at IS NULL AND expires_at>=?").bind(hash, t);
      } else if (p.value.serial !== undefined) {
        const serial = p.value.serial.trim().toUpperCase();
        if (!SERIAL.test(serial)) return c.json({ error: "invalid request" }, 400);
        via = "serial";
        // The serial is an identifier, not a secret: it binds only the key staff expected (when recorded), only once, only before it expires.
        insert = db.prepare(
          `${head} SELECT ?1, rh.account_id, COALESCE(rh.name, 'My Hub'), ?2, ?3, ?4, ?5, ?6 FROM reserved_hubs rh
           WHERE rh.serial = ?7 AND rh.used_at IS NULL AND rh.expires_at >= ?6 AND rh.edition = ?3 AND (rh.public_key IS NULL OR rh.public_key = ?2)
             AND ${entitledSql("rh.account_id", "?6")}`,
        ).bind(hubId, publicKey, edition, profile, version, t, serial);
        consume = db.prepare("UPDATE reserved_hubs SET used_at=?1, hub_id=?3 WHERE serial=?2 AND used_at IS NULL AND EXISTS (SELECT 1 FROM hubs WHERE id=?3)").bind(t, serial, hubId);
        live = db.prepare("SELECT 1 AS x FROM reserved_hubs WHERE serial=? AND used_at IS NULL AND expires_at>=? AND edition=? AND (public_key IS NULL OR public_key=?)").bind(serial, t, edition, publicKey);
      } else {
        const key = normalizeLicenseKey(p.value.licenseKey);
        if (!key) return c.json({ error: "invalid request" }, 400);
        const hash = await licenseKeyHash(c.env.PORTAL_SECRETS, key);
        via = "license_key";
        // BYO only; the key stays valid for the next Hub slot until revoked.
        insert = db.prepare(
          `${head} SELECT ?1, lk.account_id, 'My Hub', ?2, ?3, ?4, ?5, ?6 FROM license_keys lk
           WHERE lk.key_hash = ?7 AND lk.revoked_at IS NULL
             AND EXISTS (SELECT 1 FROM entitlements b WHERE b.account_id = lk.account_id AND b.plan = 'byo')
             AND ${entitledSql("lk.account_id", "?6")}`,
        ).bind(hubId, publicKey, edition, profile, version, t, hash);
        consume = db.prepare("UPDATE license_keys SET last_used_at=?1, use_count=use_count+1 WHERE key_hash=?2 AND EXISTS (SELECT 1 FROM hubs WHERE id=?3)").bind(t, hash, hubId);
        live = db.prepare("SELECT 1 AS x FROM license_keys WHERE key_hash=? AND revoked_at IS NULL").bind(hash);
      }
      let results: D1Result[];
      try {
        results = await db.batch([insert, consume]);
      } catch (err) {
        if (/UNIQUE/i.test(String((err as Error)?.message))) return c.json({ error: "hub key already registered" }, 409); // batch rolled back: credential stays unused
        throw err;
      }
      if (!results[0].meta?.changes || !results[1].meta?.changes) {
        if (await live.first()) { success = true; return c.json({ error: "plan does not allow another hub" }, 402); } // not a guess: refund the slot // live credential, but no active entitlement or no free slot
        return c.json({ error: "invalid or expired code" }, 400);
      }
      const acct = (await db.prepare("SELECT account_id FROM hubs WHERE id=?").bind(hubId).first<{ account_id: string }>())!.account_id;
      success = true;
      await audit(c, "hub.pair.complete", hubId, { accountId: acct, edition, via });
      return c.json({ hubId });
    } finally {
      if (success) await rateRefund(db, `pairfail:${ip}`, PAIR_FAIL_RATE);
    }
  });

  // Static detail page (one page for every id; its script reads the id from the path).
  app.get("/hubs/:id", (c) => c.env.ASSETS.fetch(new Request(new URL("/hub", c.req.url), { headers: c.req.raw.headers })));

  app.get("/api/hubs", requireUser, async (c) => {
    const u = c.get("user");
    const r = await c.env.DB.prepare("SELECT * FROM hubs WHERE account_id=? ORDER BY created_at").bind(u.accountId).all();
    return c.json({ hubs: (r.results ?? []).map(publicHub) });
  });

  // Detail + metrics: scoped to the caller's account (owner or member; view-as sessions are read-only members). Other accounts' Hubs answer 404.
  app.get("/api/hubs/:id", requireUser, async (c) => {
    // The public IP is for the owner (and read-only view-as sessions); members never get the object.
    const u = c.get("user");
    const hub = await loadDetail(c.env.DB, c.req.param("id"), u.accountId, u.role === "owner" || !!c.get("viewAs"));
    if (!hub) return c.json({ error: "not found" }, 404);
    const { accountId: _a, ...out } = hub;
    return c.json({ hub: out });
  });

  app.get("/api/hubs/:id/metrics", requireUser, async (c) => {
    const range = c.req.query("range") ?? "24h";
    if (!(range in RANGES)) return c.json({ error: "bad range" }, 400);
    const hub = await loadDetail(c.env.DB, c.req.param("id"), c.get("user").accountId);
    if (!hub) return c.json({ error: "not found" }, 404);
    return c.json(await loadMetrics(c.env.DB, hub.id, range as Range));
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
    await c.env.DB.prepare("DELETE FROM hub_metrics WHERE hub_id=?").bind(id).run();
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
    const t = now();
    const net = publicNet(c);
    // stats_json is the latest snapshot as validated (re-serialised from the parsed value, never the raw body); NULL when the Hub sent none.
    // The connector snapshot is stored apart (connectors_json): replaced when the Hub sends the array (even empty), kept when it does not.
    const { connectors, ...stats } = v.stats ?? {};
    await c.env.DB.prepare("UPDATE hubs SET version=?, profile=?, health_ok=?, health_json=?, stats_json=?, connectors_json=COALESCE(?, connectors_json), last_seen=? WHERE id=?")
      .bind(v.version, v.profile, v.health.ok ? 1 : 0, JSON.stringify(v.health), v.stats ? JSON.stringify(stats) : null, connectors ? JSON.stringify(connectors) : null, t, hub.id).run();
    if (net) {
      // Current values only. net_changed_at moves only when the IP differs from what is stored.
      const changed = net.ip !== hub.net_ip;
      await c.env.DB.prepare("UPDATE hubs SET net_ip=?, net_isp=?, net_asn=?, net_city=?, net_region=?, net_country=?, net_tz=?, net_changed_at=CASE WHEN ? THEN ? ELSE net_changed_at END WHERE id=?")
        .bind(net.ip, net.isp, net.asn, net.city, net.region, net.country, net.tz, changed ? 1 : 0, t, hub.id).run();
      if (changed && hub.net_ip) await audit(c, "hub.public_ip_changed", hub.id); // hub id only: the address itself is never written to the audit log
    }
    if (v.stats) await recordMetric(c.env.DB, hub.id, stats, t);
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
