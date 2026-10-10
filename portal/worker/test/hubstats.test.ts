import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { app } from "../src/index";
import { prune } from "../src/cron";
import { applyEntitlement } from "../src/billing/entitlements";
import { b64encode, sha256Hex } from "../src/hubs/crypto";
import { MAX_BODY, parseHeartbeat } from "../src/hubs/schema";
import { METRIC_RETAIN_S, downsample, type MetricPoint } from "../src/hubs/stats";
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

const sample = () => ({
  uptime_s: 864000, cpu_pct: 37.5, load1: 1.8, mem_used_mb: 21000, mem_total_mb: 65536, disk_used_gb: 412.3, disk_total_gb: 1000, temp_c: 58,
  gpu: [{ name: "NVIDIA GeForce RTX 5080", util_pct: 62, mem_used_mb: 11000, mem_total_mb: 16384, temp_c: 66 }],
  services: [["voice", "ok", 86000], ["router", "ok"], ["vision", "degraded", 120]],
  ai: { mode: "local+cloud", models: [{ lane: "fast", name: "qwen3:8b", loaded: true }, { lane: "brain", name: "nvidia/nemotron-3-super:q4", loaded: false }], avg_latency_ms: 840 },
  activity: { requests_24h: 120, requests_7d: 800, wakes_24h: 33, approvals_pending: 1, approvals_24h: 4 },
  updates: { latest_known: "1.9.0", last_result: "ok", last_at: 1_790_000_000 },
});
const hbBody = (stats?: unknown) => ({ version: "1.8.2", profile: "home", updateChannel: "stable", health: { ok: true, services: [["voice", "ok"], ["router", "ok", 90]] }, ...(stats === undefined ? {} : { stats }) });

describe("stats schema", () => {
  it("accepts the full sample (incl. 3-tuple services) and a heartbeat without stats", () => {
    const r = parseHeartbeat(hbBody(sample()));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.value.stats?.gpu?.[0].name).toBe("NVIDIA GeForce RTX 5080"); expect(r.value.stats?.services?.[0]).toEqual(["voice", "ok", 86000]); }
    expect(parseHeartbeat(hbBody()).ok).toBe(true);
    expect(JSON.stringify(hbBody(sample())).length).toBeLessThan(MAX_BODY);
  });
  it("accepts empty and partial stats (every field optional, 2- and 3-tuple services)", () => {
    for (const st of [{}, { gpu: [] }, { cpu_pct: 3 }, { mem_used_mb: 5 }, { activity: {} }, { activity: { requests_24h: 2 } }, { ai: {} }, { ai: { mode: "local" } }, { updates: {} },
      { services: [["a", "ok"], ["b", "down", 5]] }, { activity: { wakes_24h: 0 } }]) expect(parseHeartbeat(hbBody(st)).ok).toBe(true);
    const r = parseHeartbeat(hbBody({ activity: { requests_24h: 2 } }));
    expect(r.ok && r.value.stats).toEqual({ activity: { requests_24h: 2 } });
  });
  const mutate = (f: (s: any) => void) => { const s: any = sample(); f(s); return parseHeartbeat(hbBody(s)); };
  it("rejects unknown keys at every level", () => {
    for (const f of [
      (s: any) => { s.hostname = "x"; }, (s: any) => { s.gpu[0].driver = "1"; }, (s: any) => { s.ai.prompt = "hi"; }, (s: any) => { s.ai.models[0].path = "/x"; },
      (s: any) => { s.activity.transcript = 1; }, (s: any) => { s.updates.note = "x"; },
    ]) expect(mutate(f).ok).toBe(false);
    expect(parseHeartbeat({ ...hbBody(sample()), extra: 1 }).ok).toBe(false);
  });
  it("rejects out-of-range and inconsistent numbers", () => {
    const cases: ((s: any) => void)[] = [
      (s) => { s.cpu_pct = 101; }, (s) => { s.cpu_pct = -1; }, (s) => { s.cpu_pct = "5"; }, (s) => { s.cpu_pct = NaN; }, (s) => { s.uptime_s = 1.5; }, (s) => { s.uptime_s = -1; },
      (s) => { s.mem_used_mb = s.mem_total_mb + 1; }, (s) => { s.disk_used_gb = 2000; }, (s) => { s.load1 = -0.1; }, (s) => { s.temp_c = 500; },
      (s) => { s.gpu[0].util_pct = 120; }, (s) => { s.gpu[0].mem_used_mb = 99999; }, (s) => { s.activity.requests_24h = -1; }, (s) => { s.activity.wakes_24h = 1.2; },
      (s) => { s.ai.avg_latency_ms = -5; }, (s) => { s.updates.last_at = -1; }, (s) => { s.services[0][2] = -1; },
    ];
    for (const f of cases) expect(mutate(f).ok).toBe(false);
  });
  it("rejects free text, bad enums and oversized lists", () => {
    const cases: ((s: any) => void)[] = [
      (s) => { s.gpu[0].name = "x".repeat(65); }, (s) => { s.gpu[0].name = "hello\nworld"; }, (s) => { s.gpu[0].name = "<script>"; },
      (s) => { s.services[0][0] = "a".repeat(33); }, (s) => { s.services[0][0] = "voice agent!"; }, (s) => { s.services[0][1] = "unknown"; },
      (s) => { s.ai.mode = "cloud"; }, (s) => { s.ai.models[0].lane = "secret"; }, (s) => { s.ai.models[0].name = "user said: turn on the lights, please, and tell mom"; },
      (s) => { s.ai.models[0].loaded = "yes"; }, (s) => { s.updates.last_result = "maybe"; }, (s) => { s.updates.latest_known = "latest build"; },
      (s) => { s.gpu = Array(5).fill(s.gpu[0]); }, (s) => { s.services = Array(25).fill(["a", "ok"]); },
      (s) => { s.ai.models = Array(13).fill({ lane: "fast", name: "m", loaded: true }); }, (s) => { s.services = [["a", "ok", 1, 2]]; }, (s) => { s.services = ["voice"]; },
    ];
    for (const f of cases) expect(mutate(f).ok).toBe(false);
    expect(parseHeartbeat(hbBody("lots of text")).ok).toBe(false);
  });
});

describe("downsample", () => {
  const pt = (ts: number, cpu: number | null): MetricPoint => ({ ts, cpu, mem_pct: 50, gpu_util: null, gpu_mem_pct: null, latency_ms: null });
  it("leaves small series alone", () => {
    const pts = [pt(10, 1), pt(20, 2)];
    expect(downsample(pts, 0, 100)).toBe(pts);
  });
  it("buckets 7 days of 5-minute points into <= 300 averaged points, in order, null-aware", () => {
    const from = 1_000_000, to = from + 7 * 86400;
    const pts = Array.from({ length: 2016 }, (_, i) => pt(from + i * 300, i % 2 ? 20 : 40));
    const out = downsample(pts, from, to);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.length).toBeGreaterThan(250);
    expect(out.every((p, i) => i === 0 || p.ts > out[i - 1].ts)).toBe(true);
    expect(out.every((p) => p.cpu !== null && p.cpu >= 20 && p.cpu <= 40)).toBe(true);
    expect(out[0].gpu_util).toBeNull();
    expect(out[0].mem_pct).toBe(50);
  });
});

describe("hub telemetry end to end", () => {
  let OWNER: string, MEMBER: string, OTHER: string, hub: { id: string; kp: CryptoKeyPair };
  let seq = 0, ipN = 0;
  const call = (path: string, cookie?: string, init: RequestInit = {}) => client(cookie, env()).request(path, { ...init, headers: { "cf-connecting-ip": `10.7.0.${ipN}`, ...(init.headers as Record<string, string> | undefined) } });

  async function pair(cookie: string) {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = b64encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey) as ArrayBuffer));
    const { code } = await (await call("/api/hubs/pair/start", cookie, { method: "POST" })).json() as any;
    const r = await call("/api/hubs/pair/complete", undefined, { method: "POST", body: JSON.stringify({ code, hubPublicKey: pub, edition: "mac", profile: "home", version: "1.0.0" }) });
    return { id: ((await r.json()) as any).hubId as string, kp };
  }
  async function heartbeat(h: { id: string; kp: CryptoKeyPair }, body: unknown, ts = Math.floor(Date.now() / 1000)) {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const path = "/api/hubs/heartbeat";
    const sig = b64encode(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, h.kp.privateKey, new TextEncoder().encode(`POST\n${path}\n${ts}\n${await sha256Hex(raw)}`))));
    return call(path, undefined, { method: "POST", body: raw, headers: { "x-hub-id": h.id, "x-hub-timestamp": String(ts), "x-hub-signature": sig } });
  }

  beforeEach(async () => {
    await clearPortalTables();
    OWNER = await login(await seedOwner("hs-u1", "hs-acc1"));
    MEMBER = await login(await seedMember("hs-u3", "hs-acc1"));
    OTHER = await login(await seedOwner("hs-u2", "hs-acc2"));
    await applyEntitlement(e.DB, "hs-acc1", { plan: "estate", status: "active" }, ++seq);
    ipN++;
    hub = await pair(OWNER);
    expect(hub.id).toBeTruthy();
  });

  it("stores the snapshot, shows it in detail/list, and keeps at most one point per 5 minutes", async () => {
    const t = Math.floor(Date.now() / 1000);
    expect((await heartbeat(hub, hbBody(sample()), t)).status).toBe(200);
    expect((await heartbeat(hub, hbBody({ ...sample(), cpu_pct: 90 }), t + 60)).status).toBe(200); // within 5 min: no new point
    const stored = await e.DB.prepare("SELECT cpu, mem_pct, gpu_util, gpu_mem_pct, latency_ms FROM hub_metrics WHERE hub_id = ?").bind(hub.id).all();
    expect(stored.results).toHaveLength(1);
    expect(stored.results[0]).toMatchObject({ cpu: 37.5, gpu_util: 62, latency_ms: 840 });
    expect((stored.results[0] as any).mem_pct).toBeCloseTo(32.0, 0);
    // a later point (> 5 minutes after the stored one) is kept
    await e.DB.prepare("UPDATE hub_metrics SET ts = ts - 400 WHERE hub_id = ?").bind(hub.id).run();
    await heartbeat(hub, hbBody(sample()), t + 120);
    expect((await e.DB.prepare("SELECT COUNT(*) n FROM hub_metrics WHERE hub_id = ?").bind(hub.id).first<{ n: number }>())!.n).toBe(2);

    const d = (await (await call(`/api/hubs/${hub.id}`, OWNER)).json() as any).hub;
    expect(d).toMatchObject({ id: hub.id, online: true, version: "1.8.2" });
    expect(d.stats.cpu_pct).toBe(37.5);
    expect(d.stats.services[0]).toEqual(["voice", "ok", 86000]);
    expect(d.accountId).toBeUndefined();
    const list = (await (await call("/api/hubs", OWNER)).json() as any).hubs[0];
    expect(list.online).toBe(true);
    expect(list.summary).toEqual({ cpu_pct: 37.5, mem_used_mb: 21000, mem_total_mb: 65536 });
    expect(list.stats).toBeUndefined();
  });

  it("rejects bad stats with 400 and leaves the snapshot untouched; oversized body is 413", async () => {
    await heartbeat(hub, hbBody(sample()));
    expect((await heartbeat(hub, hbBody({ ...sample(), cpu_pct: 500 }))).status).toBe(400);
    expect((await heartbeat(hub, hbBody({ ...sample(), secret: "x" }))).status).toBe(400);
    expect((await heartbeat(hub, JSON.stringify(hbBody({ ...sample(), pad: "x".repeat(MAX_BODY) })))).status).toBe(413);
    expect(((await (await call(`/api/hubs/${hub.id}`, OWNER)).json()) as any).hub.stats.cpu_pct).toBe(37.5);
  });

  it("a heartbeat without stats clears the snapshot and records no point", async () => {
    await heartbeat(hub, hbBody(sample()));
    await heartbeat(hub, hbBody());
    expect(((await (await call(`/api/hubs/${hub.id}`, OWNER)).json()) as any).hub.stats).toBeNull();
  });

  it("reports offline after 15 minutes", async () => {
    await heartbeat(hub, hbBody(sample()));
    await e.DB.prepare("UPDATE hubs SET last_seen = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000) - 16 * 60, hub.id).run();
    expect(((await (await call(`/api/hubs/${hub.id}`, OWNER)).json()) as any).hub.online).toBe(false);
    await e.DB.prepare("UPDATE hubs SET last_seen = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000) - 14 * 60, hub.id).run();
    expect(((await (await call(`/api/hubs/${hub.id}`, OWNER)).json()) as any).hub.online).toBe(true);
  });

  it("serves metrics for 24h and 7d (downsampled <= 300) and rejects other ranges", async () => {
    const t = Math.floor(Date.now() / 1000);
    const rows = Array.from({ length: 2000 }, (_, i) => e.DB.prepare("INSERT INTO hub_metrics(hub_id,ts,cpu,mem_pct) VALUES(?,?,?,?)").bind(hub.id, t - i * 300 - 10, i % 100, 40));
    await e.DB.batch(rows);
    const w = (await (await call(`/api/hubs/${hub.id}/metrics?range=7d`, OWNER)).json()) as any;
    expect(w.range).toBe("7d");
    expect(w.points.length).toBeLessThanOrEqual(300);
    expect(w.points.length).toBeGreaterThan(100);
    const d = (await (await call(`/api/hubs/${hub.id}/metrics`, OWNER)).json()) as any;
    expect(d.range).toBe("24h");
    expect(d.points.length).toBeLessThanOrEqual(288);
    expect(d.points.every((p: any) => p.ts >= t - 86400)).toBe(true);
    expect((await call(`/api/hubs/${hub.id}/metrics?range=30d`, OWNER)).status).toBe(400);
  });

  it("authz: owner and member see it; another account's user, anonymous and unknown ids get 404/401", async () => {
    for (const p of [`/api/hubs/${hub.id}`, `/api/hubs/${hub.id}/metrics?range=24h`]) {
      expect([p, (await call(p, OWNER)).status]).toEqual([p, 200]);
      expect([p, (await call(p, MEMBER)).status]).toEqual([p, 200]);
      expect([p, (await call(p, OTHER)).status]).toEqual([p, 404]);
      expect([p, (await call(p)).status]).toEqual([p, 401]);
    }
    expect((await call("/api/hubs/does-not-exist", OWNER)).status).toBe(404);
    expect((await call(`/api/hubs/${hub.id}`, OTHER)).status).toBe(404);
    // other account's list never contains it
    expect(((await (await call("/api/hubs", OTHER)).json()) as any).hubs).toHaveLength(0);
  });

  it("view-as (read-only) can read detail and metrics; staff API needs Access and reads any account", async () => {
    const jwt = await new SignJWT({ email: ADMIN }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`https://${TEAM}`).setAudience(AUD).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
    const staff = (path: string, token: string | null = jwt) => app.request(ORIGIN + path, { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {}, redirect: "manual" }, env());
    await heartbeat(hub, hbBody(sample()));

    const va = await staff("/support/view-as?account=hs-acc1");
    expect(va.status).toBe(302);
    const cookie = (va.headers.get("set-cookie") ?? "").split(";")[0];
    for (const p of [`/api/hubs/${hub.id}`, `/api/hubs/${hub.id}/metrics?range=7d`]) expect([p, (await call(p, cookie)).status]).toEqual([p, 200]);
    expect((await call(`/api/hubs/${hub.id}`, cookie, { method: "PATCH", body: JSON.stringify({ name: "x" }) })).status).toBe(403);
    expect((await call(`/api/hubs/${hub.id}`, cookie, { method: "DELETE" })).status).toBe(403);

    const s = await staff(`/api/support/hubs/${hub.id}`);
    expect(s.status).toBe(200);
    const sj = (await s.json()) as any;
    expect(sj.hub).toMatchObject({ id: hub.id, accountId: "hs-acc1", online: true });
    expect(sj.hub.stats.uptime_s).toBe(864000);
    expect((await staff(`/api/support/hubs/${hub.id}/metrics?range=24h`)).status).toBe(200);
    expect((await staff(`/api/support/hubs/${hub.id}/metrics?range=1y`)).status).toBe(400);
    expect((await staff("/api/support/hubs/nope")).status).toBe(404);
    // customers and anonymous callers cannot use the staff routes
    expect((await staff(`/api/support/hubs/${hub.id}`, null)).status).toBe(403);
    expect((await call(`/api/support/hubs/${hub.id}`, OWNER)).status).toBe(403);
    expect((await call(`/support/hubs/${hub.id}`, OWNER)).status).toBe(403);
    expect((await call(`/api/support/hubs/${hub.id}/metrics`, OTHER)).status).toBe(403);
    const audited = await e.DB.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'support.hub.view' AND target = ?").bind(hub.id).first<{ n: number }>();
    expect(audited!.n).toBe(1);
  });

  it("prune drops metrics older than 8 days and keeps newer ones; unpairing and account deletion remove them", async () => {
    const t = Math.floor(Date.now() / 1000);
    await e.DB.batch([
      e.DB.prepare("INSERT INTO hub_metrics(hub_id,ts,cpu) VALUES(?,?,1)").bind(hub.id, t - METRIC_RETAIN_S - 10),
      e.DB.prepare("INSERT INTO hub_metrics(hub_id,ts,cpu) VALUES(?,?,2)").bind(hub.id, t - METRIC_RETAIN_S + 3600),
      e.DB.prepare("INSERT INTO hub_metrics(hub_id,ts,cpu) VALUES(?,?,3)").bind(hub.id, t - 60),
    ]);
    const counts = await prune(e, t);
    expect(counts.hubMetrics).toBe(1);
    expect((await e.DB.prepare("SELECT cpu FROM hub_metrics WHERE hub_id = ? ORDER BY ts").bind(hub.id).all()).results.map((r: any) => r.cpu)).toEqual([2, 3]);
    expect((await call(`/api/hubs/${hub.id}`, OWNER, { method: "DELETE" })).status).toBe(200);
    expect((await e.DB.prepare("SELECT COUNT(*) n FROM hub_metrics WHERE hub_id = ?").bind(hub.id).first<{ n: number }>())!.n).toBe(0);
  });

  describe("public network info", () => {
    const CF = { asOrganization: "Example Fiber", asn: 64500, city: "Charlotte", region: "North Carolina", country: "US", timezone: "America/New_York" };
    let tick = 0;
    const beat = (ip: string, cf: unknown = CF) => heartbeat2(hub, hbBody(), ip, cf, Math.floor(Date.now() / 1000) + ++tick); // distinct ts per beat: an identical signature is a replay
    async function heartbeat2(h: { id: string; kp: CryptoKeyPair }, body: unknown, ip: string, cf: unknown, ts = Math.floor(Date.now() / 1000)) {
      const raw = JSON.stringify(body);
      const path = "/api/hubs/heartbeat";
      const sig = b64encode(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, h.kp.privateKey, new TextEncoder().encode(`POST\n${path}\n${ts}\n${await sha256Hex(raw)}`))));
      return call(path, undefined, { method: "POST", body: raw, cf, headers: { "cf-connecting-ip": ip, "x-hub-id": h.id, "x-hub-timestamp": String(ts), "x-hub-signature": sig } } as RequestInit);
    }
    const row = () => e.DB.prepare("SELECT * FROM hubs WHERE id = ?").bind(hub.id).first<any>();
    const detail = async (cookie: string) => ((await (await call(`/api/hubs/${hub.id}`, cookie)).json()) as any).hub;

    it("stores IP and cf fields from the heartbeat request, only current values", async () => {
      const t = Math.floor(Date.now() / 1000);
      expect((await beat("203.0.113.9")).status).toBe(200);
      const r = await row();
      expect(r).toMatchObject({ net_ip: "203.0.113.9", net_isp: "Example Fiber", net_asn: 64500, net_city: "Charlotte", net_region: "North Carolina", net_country: "US", net_tz: "America/New_York" });
      expect(r.net_changed_at).toBeGreaterThanOrEqual(t);
      expect((await e.DB.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE '%net%' AND type = 'table'").first<{ n: number }>())!.n).toBe(0);
    });

    it("same IP keeps net_changed_at; a new IP updates it and audits the change without the IP", async () => {
      await beat("203.0.113.9");
      const first = (await row()).net_changed_at;
      await e.DB.prepare("UPDATE hubs SET net_changed_at = ? WHERE id = ?").bind(1000, hub.id).run();
      await beat("203.0.113.9", { ...CF, city: "Raleigh" });
      expect(await row()).toMatchObject({ net_changed_at: 1000, net_city: "Raleigh" });
      const before = await e.DB.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'hub.public_ip_changed'").first<{ n: number }>();
      expect(before!.n).toBe(0); // first sighting and unchanged heartbeats are not changes
      await beat("198.51.100.77");
      const r = await row();
      expect(r.net_ip).toBe("198.51.100.77");
      expect(r.net_changed_at).toBeGreaterThanOrEqual(first);
      const logs = (await e.DB.prepare("SELECT target, meta FROM audit_log WHERE action = 'hub.public_ip_changed'").all<any>()).results;
      expect(logs).toHaveLength(1);
      expect(logs[0].target).toBe(hub.id);
      const dump = JSON.stringify((await e.DB.prepare("SELECT * FROM audit_log").all()).results);
      expect(dump).not.toContain("198.51.100.77");
      expect(dump).not.toContain("203.0.113.9");
    });

    it("a heartbeat with no IP leaves stored values alone", async () => {
      await beat("203.0.113.9");
      expect((await beat("")).status).toBe(200);
      expect((await row()).net_ip).toBe("203.0.113.9");
    });

    it("owner sees publicNetwork; member does not; other accounts 404; list never has it; view-as and staff see it", async () => {
      await beat("203.0.113.9");
      expect((await detail(OWNER)).publicNetwork).toEqual({ ip: "203.0.113.9", isp: "Example Fiber", asn: 64500, city: "Charlotte", region: "North Carolina", country: "US", timezone: "America/New_York", changedAt: expect.any(Number) });
      const m = await detail(MEMBER);
      expect(m).toBeDefined();
      expect("publicNetwork" in m).toBe(false);
      expect(JSON.stringify(m)).not.toContain("203.0.113.9");
      expect((await call(`/api/hubs/${hub.id}`, OTHER)).status).toBe(404);
      const list = JSON.stringify(await (await call("/api/hubs", OWNER)).json());
      expect(list).not.toContain("203.0.113.9");
      expect(list).not.toContain("publicNetwork");

      const jwt = await new SignJWT({ email: ADMIN }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`https://${TEAM}`).setAudience(AUD).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
      const staff = (path: string) => app.request(ORIGIN + path, { headers: { "Cf-Access-Jwt-Assertion": jwt }, redirect: "manual" }, env());
      const s = (await (await staff(`/api/support/hubs/${hub.id}`)).json()) as any;
      expect(s.hub.publicNetwork.ip).toBe("203.0.113.9");
      const va = await staff("/support/view-as?account=hs-acc1");
      const cookie = (va.headers.get("set-cookie") ?? "").split(";")[0];
      expect((await detail(cookie)).publicNetwork.ip).toBe("203.0.113.9");
    });

    it("export includes it for the owner; account deletion clears it", async () => {
      await beat("203.0.113.9");
      const ex = (await (await call("/api/account/export", OWNER)).json()) as any;
      expect(ex.hubs[0]).toMatchObject({ publicIp: "203.0.113.9", publicIsp: "Example Fiber", publicAsn: 64500, publicCity: "Charlotte", publicCountry: "US", publicTimezone: "America/New_York" });
      await e.DB.prepare("DELETE FROM entitlements WHERE account_id = ?").bind("hs-acc1").run(); // nothing to cancel at Stripe
      expect((await call("/api/account/delete", OWNER, { method: "POST", body: JSON.stringify({ confirm: "DELETE" }) })).status).toBe(200);
      expect(await row()).toBeNull();
      expect((await e.DB.prepare("SELECT COUNT(*) n FROM hubs WHERE net_ip IS NOT NULL").first<{ n: number }>())!.n).toBe(0);
    });
  });
});
