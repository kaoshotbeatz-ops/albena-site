import { env as rawEnv } from "cloudflare:workers";
import type { Env } from "../src/types";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "../src/index";

const env = rawEnv as unknown as Env;
let ipCounter = 0;
const nextIp = () => `203.0.113.${++ipCounter % 250}`;

async function call(path: string, init: RequestInit & { ip?: string; host?: string } = {}) {
  const { ip = nextIp(), host = "albena.ai", ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("CF-Connecting-IP", ip);
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://${host}${path}`, { ...rest, headers }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// The Turnstile mock echoes the action the real widget would have been rendered with.
let currentAction = "waitlist";
const post = (path: string, body: unknown, extra: RequestInit & { ip?: string } = {}) => {
  currentAction = path.includes("support") ? "support" : "waitlist";
  return call(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...extra,
  });
};

const mockTurnstile = (success: boolean, over: Record<string, unknown> = {}) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("challenges.cloudflare.com")) return Response.json({ success, hostname: "albena.ai", action: currentAction, ...over });
    throw new Error(`unexpected fetch ${url}`);
  });

const valid = { email: "Jane.Doe+news@Gmail.com", name: "Jane", interest: "voice", turnstileToken: "tok" };

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM waitlist"),
    env.DB.prepare("DELETE FROM tickets"),
    env.DB.prepare("DELETE FROM audit_log"),
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe("health + headers", () => {
  it("GET /api/health works and has all security headers + no-store", async () => {
    const res = await call("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains; preload");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("Permissions-Policy")).toContain("camera=()");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
  });

  it("static assets and 404s carry security headers too", async () => {
    for (const p of ["/", "/definitely-missing"]) {
      const res = await call(p);
      expect(res.headers.get("Strict-Transport-Security")).toContain("preload");
      expect(res.headers.get("Content-Security-Policy")).toContain("object-src 'none'");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("Server")).toBeNull();
    }
  });

  it("www redirects 301 to apex with headers", async () => {
    const res = await call("/support?x=1", { host: "www.albena.ai", redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://albena.ai/support?x=1");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("errors are JSON without stack traces", async () => {
    const res = await call("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("POST /api/waitlist", () => {
  it("rejects invalid input", async () => {
    const spy = mockTurnstile(true);
    const bad = await post("/api/waitlist", { email: "nope", turnstileToken: "t" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toBe("validation_failed");
    expect((await post("/api/waitlist", "{not json")).status).toBe(400);
    expect((await post("/api/waitlist", { email: "a@b.co" })).status).toBe(400); // no token
    expect((await call("/api/waitlist", { method: "POST", body: "x" })).status).toBe(415);
    expect(spy).not.toHaveBeenCalled();
  });

  it("creates (201), dedupes normalised email (200), stores hashed IP only", async () => {
    mockTurnstile(true);
    const ip = "198.51.100.7";
    const r1 = await post("/api/waitlist", valid, { ip });
    expect(r1.status).toBe(201);
    const r2 = await post("/api/waitlist", { ...valid, email: "janedoe@gmail.com" }, { ip: nextIp() });
    expect(r2.status).toBe(200);
    const rows = (await env.DB.prepare("SELECT * FROM waitlist").all()).results as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("jane.doe+news@gmail.com");
    expect(rows[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(ip);
    const audit = (await env.DB.prepare("SELECT action, ip_hash FROM audit_log ORDER BY id").all()).results as any[];
    expect(audit.map((a) => a.action)).toEqual(["waitlist.create", "waitlist.duplicate"]);
    expect(JSON.stringify(audit)).not.toContain(ip);
  });

  it("honeypot: pretends success, stores nothing, skips Turnstile", async () => {
    const spy = mockTurnstile(true);
    const res = await post("/api/waitlist", { ...valid, website: "http://spam.example" });
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    expect((await env.DB.prepare("SELECT count(*) c FROM waitlist").first<{ c: number }>())!.c).toBe(0);
    const a = await env.DB.prepare("SELECT action FROM audit_log").all();
    expect((a.results[0] as any).action).toBe("waitlist.honeypot");
  });

  it("turnstile failure -> 403 and nothing stored", async () => {
    mockTurnstile(false);
    const res = await post("/api/waitlist", valid);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe("turnstile_failed");
    expect((await env.DB.prepare("SELECT count(*) c FROM waitlist").first<{ c: number }>())!.c).toBe(0);
  });

  it("turnstile wrong hostname or action -> 403 and nothing stored", async () => {
    for (const over of [{ hostname: "evil.example" }, { action: "support" }, { action: undefined }, { hostname: "localhost" }]) {
      vi.restoreAllMocks();
      mockTurnstile(true, over);
      const res = await post("/api/waitlist", valid);
      expect(res.status, JSON.stringify(over)).toBe(403);
    }
    expect((await env.DB.prepare("SELECT count(*) c FROM waitlist").first<{ c: number }>())!.c).toBe(0);
    vi.restoreAllMocks();
    mockTurnstile(true, { hostname: "www.albena.ai" });
    expect((await post("/api/waitlist", valid)).status).toBe(201);
  });

  it("waitlist row and audit row are written atomically", async () => {
    mockTurnstile(true);
    expect((await post("/api/waitlist", valid)).status).toBe(201);
    const a = (await env.DB.prepare("SELECT action, target FROM audit_log").all()).results as any[];
    expect(a).toHaveLength(1);
    expect(a[0].action).toBe("waitlist.create");
    expect(a[0].target).toMatch(/^waitlist:\d+$/);
    // Break audit_log: the whole batch must roll back, leaving no PII row.
    await env.DB.prepare("ALTER TABLE audit_log RENAME TO audit_log_x").run();
    try {
      const res = await post("/api/waitlist", { ...valid, email: "other@example.com" });
      expect(res.status).toBe(500);
      expect((await env.DB.prepare("SELECT count(*) c FROM waitlist").first<{ c: number }>())!.c).toBe(1);
    } finally {
      await env.DB.prepare("ALTER TABLE audit_log_x RENAME TO audit_log").run();
    }
  });

  it("rejects oversized bodies by Content-Length and by actual bytes", async () => {
    const spy = mockTurnstile(true);
    const big = JSON.stringify({ ...valid, interest: "x".repeat(17000) });
    expect((await post("/api/waitlist", big)).status).toBe(413);
    // multi-byte: < 16384 chars but > 16384 bytes
    const mb = JSON.stringify({ ...valid, interest: "\u00e9".repeat(9000) });
    expect(mb.length).toBeLessThan(16384);
    expect((await post("/api/waitlist", mb)).status).toBe(413);
    // lying / absent Content-Length (chunked stream) is still capped
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); },
    });
    const res = await call("/api/waitlist", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect((await call("/api/waitlist", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "99999" }, body: "{}" })).status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
  });

  it("turnstile unreachable -> 503", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    expect((await post("/api/waitlist", valid)).status).toBe(503);
  });

  it("cross-origin POST is refused", async () => {
    mockTurnstile(true);
    const res = await post("/api/waitlist", valid, { headers: { "Content-Type": "application/json", Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("rate limits after ~5 requests per minute per IP", async () => {
    mockTurnstile(true);
    const ip = "192.0.2.99";
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      codes.push((await post("/api/waitlist", { ...valid, email: `u${i}@example.com` }, { ip })).status);
    }
    expect(codes.slice(0, 5).every((c) => c === 201)).toBe(true);
    expect(codes).toContain(429);
    const limited = await post("/api/waitlist", valid, { ip });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
  });
});

describe("POST /api/support", () => {
  const ticket = { name: "Jane", email: "jane@example.com", topic: "bug", message: "It broke.", turnstileToken: "t" };

  it("creates a ticket with ALB-###### id", async () => {
    mockTurnstile(true);
    const res = await post("/api/support", ticket);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(id).toMatch(/^ALB-\d{6}$/);
    const a = await env.DB.prepare("SELECT action, target FROM audit_log WHERE action = 'support.create'").first<any>();
    expect(a.target).toBe(`ticket:${id}`);
    const row = await env.DB.prepare("SELECT status, ip_hash FROM tickets WHERE ticket_id = ?").bind(id).first<any>();
    expect(row.status).toBe("open");
    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("validates topic enum and message length", async () => {
    mockTurnstile(true);
    expect((await post("/api/support", { ...ticket, topic: "weird" })).status).toBe(400);
    expect((await post("/api/support", { ...ticket, message: "x".repeat(4001) })).status).toBe(400);
    expect((await post("/api/support", { ...ticket, message: "x".repeat(4000) })).status).toBe(201);
  });

  it("honeypot and turnstile failure create no ticket", async () => {
    mockTurnstile(false);
    expect((await post("/api/support", { ...ticket, website: "x" })).status).toBe(200);
    expect((await post("/api/support", ticket)).status).toBe(403);
    expect((await env.DB.prepare("SELECT count(*) c FROM tickets").first<{ c: number }>())!.c).toBe(0);
  });
});

// The worker caches the Access JWKS per team domain for the isolate's lifetime, so all tests share one keypair.
let keyPromise: ReturnType<typeof makeKey> | undefined;
async function makeKey() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  return { privateKey, jwk: { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" } };
}
const accessKey = () => (keyPromise ??= makeKey());

describe("admin", () => {
  const paths = ["/api/admin/integrity", "/api/admin/waitlist", "/api/admin/tickets", "/api/admin/export/waitlist.csv", "/api/admin/export/tickets.csv", "/api/admin/audit", "/admin/", "/admin/index.html"];

  it("denies without JWT (deny by default)", async () => {
    for (const p of paths) {
      const res = await call(p);
      expect(res.status, p).toBe(403);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    }
    expect((await call("/api/admin/tickets/ALB-000001", { method: "PATCH", body: "{}" })).status).toBe(403);
    for (const p of ["/api/admin/backup/run", "/api/admin/backup/verify", "/api/admin/audit/repair"]) {
      expect((await call(p, { method: "POST" })).status, p).toBe(403);
      expect((await call(p, { method: "POST", headers: { "X-Requested-With": "albena-admin" } })).status, p).toBe(403);
    }
  });

  it("denies a garbage JWT", async () => {
    const res = await call("/api/admin/waitlist", { headers: { "Cf-Access-Jwt-Assertion": "a.b.c" } });
    expect(res.status).toBe(403);
  });

  it("allows a valid Access JWT, lists, updates, exports and audits", async () => {
    const { privateKey, jwk } = await accessKey();
    const jwt = await new SignJWT({ email: "omar@dbaomarhuertasllc.com" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(`https://${env.TEAM_DOMAIN}`)
      .setAudience(env.ADMIN_AUD)
      .setSubject("u1")
      .setExpirationTime("5m")
      .sign(privateKey);
    const wrongAud = await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(`https://${env.TEAM_DOMAIN}`).setAudience("other").setExpirationTime("5m").sign(privateKey);

    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/cdn-cgi/access/certs")) return Response.json({ keys: [jwk] });
      if (url.includes("challenges.cloudflare.com")) return Response.json({ success: true, hostname: "albena.ai", action: "support" });
      return realFetch(input, init);
    });

    await post("/api/support", { name: "J", email: "j@example.com", topic: "bug", message: "hi", turnstileToken: "t" });
    const h = { "Cf-Access-Jwt-Assertion": jwt };

    expect((await call("/api/admin/waitlist", { headers: { "Cf-Access-Jwt-Assertion": wrongAud } })).status).toBe(403);

    const list = await call("/api/admin/tickets", { headers: h });
    expect(list.status).toBe(200);
    const items = ((await list.json()) as any).items;
    expect(items[0].ticket_id).toMatch(/^ALB-/);

    const patch = await call(`/api/admin/tickets/${items[0].ticket_id}`, {
      method: "PATCH", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ status: "resolved" }),
    });
    expect(patch.status).toBe(403);
    expect(((await patch.json()) as any).error).toBe("csrf_header_required");
    const wrongCsrf = await call(`/api/admin/tickets/${items[0].ticket_id}`, {
      method: "PATCH", headers: { ...h, "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/json" }, body: JSON.stringify({ status: "resolved" }),
    });
    expect(wrongCsrf.status).toBe(403);
    const patchOk = await call(`/api/admin/tickets/${items[0].ticket_id}`, {
      method: "PATCH", headers: { ...h, "X-Requested-With": "albena-admin", "Content-Type": "application/json" }, body: JSON.stringify({ status: "resolved" }),
    });
    expect(patchOk.status).toBe(200);
    expect((await env.DB.prepare("SELECT status FROM tickets").first<{ status: string }>())!.status).toBe("resolved");

    const integ = await call("/api/admin/integrity", { headers: h });
    expect(integ.status).toBe(200);
    const ib = (await integ.json()) as any;
    expect(ib.chain.ok).toBe(true);
    expect(ib.chain.unsealed).toBe(0);
    expect(ib.lastBackupOk).toBe(false);

    const csv = await call("/api/admin/export/tickets.csv", { headers: h });
    expect(csv.headers.get("Content-Type")).toContain("text/csv");
    expect(await csv.text()).toContain("resolved");

    const actions = ((await env.DB.prepare("SELECT actor, action FROM audit_log").all()).results as any[]);
    expect(actions.some((a) => a.actor === "omar@dbaomarhuertasllc.com" && a.action === "admin.ticket.status:resolved")).toBe(true);
    expect(actions.some((a) => a.action === "admin.denied")).toBe(true);
  });
});

describe("admin audit list", () => {
  async function accessHeaders() {
    const { privateKey, jwk } = await accessKey();
    const jwt = await new SignJWT({ email: "omar@dbaomarhuertasllc.com" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(`https://${env.TEAM_DOMAIN}`).setAudience(env.ADMIN_AUD).setSubject("u1").setExpirationTime("5m").sign(privateKey);
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/cdn-cgi/access/certs")) return Response.json({ keys: [jwk] });
      return realFetch(input, init);
    });
    return { "Cf-Access-Jwt-Assertion": jwt };
  }

  it("is denied without Access and is noindex", async () => {
    const res = await call("/api/admin/audit");
    expect(res.status).toBe(403);
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
  });

  it("paginates newest-first, hides ip_hash and full hashes, and rejects bad params", async () => {
    const h = await accessHeaders();
    await env.DB.batch([1, 2, 3, 4, 5].map((i) =>
      env.DB.prepare("INSERT INTO audit_log (actor, action, target, request_id, ip_hash) VALUES ('x', ?, 't', 'r', 'secretiphash')").bind(`seed${i}`)));
    const p1 = await call("/api/admin/audit?limit=2", { headers: h });
    expect(p1.status).toBe(200);
    const b1 = (await p1.json()) as any;
    expect(b1.items).toHaveLength(2);
    expect(b1.items[0].id).toBeGreaterThan(b1.items[1].id);
    expect(Object.keys(b1.items[0]).sort()).toEqual(["action", "actor", "hash_prefix", "id", "request_id", "target", "ts"]);
    expect(JSON.stringify(b1)).not.toContain("secretiphash");
    expect(b1.items.every((i: any) => i.hash_prefix === null || i.hash_prefix.length === 12)).toBe(true);
    expect(b1.next_before).toBe(b1.items[1].id);
    const p2 = (await (await call(`/api/admin/audit?limit=2&before=${b1.next_before}`, { headers: h })).json()) as any;
    expect(p2.items.every((i: any) => i.id < b1.next_before)).toBe(true);
    const all = (await (await call("/api/admin/audit?limit=200", { headers: h })).json()) as any;
    expect(all.next_before).toBeNull();
    for (const bad of ["limit=0", "limit=201", "before=abc", "before=0"]) {
      expect((await call(`/api/admin/audit?${bad}`, { headers: h })).status, bad).toBe(400);
    }
  });
});
