import { createRemoteJWKSet, jwtVerify } from "jose";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "./types";
import { audit } from "./util";
import { repairChain, verifyChain } from "./auditchain";
import { runBackup, runVerify, statusSummary } from "./maintenance";
import { json } from "./security";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Verifies the Cloudflare Access JWT. Returns actor identity or null (deny). */
export async function verifyAccess(req: Request, env: Env): Promise<string | null> {
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  const team = env.TEAM_DOMAIN;
  const aud = env.ADMIN_AUD;
  if (!token || !team || !aud) return null; // deny by default
  try {
    let jwks = jwksCache.get(team);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
      jwksCache.set(team, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://${team}`,
      audience: aud,
      algorithms: ["RS256"],
    });
    const id = (payload.email as string | undefined) ?? payload.sub;
    return id ? String(id) : null;
  } catch {
    return null;
  }
}

export const denied = () => json({ error: "forbidden" }, 403);

export async function requireAccess(c: import("hono").Context<AppEnv>, next: () => Promise<void>) {
  const actor = await verifyAccess(c.req.raw, c.env);
  if (!actor) {
    await audit(c.env, {
      actor: "anonymous",
      action: "admin.denied",
      target: new URL(c.req.url).pathname,
      requestId: c.get("requestId"),
      ipHash: c.get("ipHash"),
    }).catch(() => {});
    return denied();
  }
  c.set("actor", actor);
  await next();
}

function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
  return `"${s.replaceAll('"', '""')}"`;
}

function toCsv(rows: Record<string, unknown>[], cols: string[]): string {
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";
}

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(["open", "in_progress", "resolved", "closed"]).optional(),
});

const patchSchema = z.object({ status: z.enum(["open", "in_progress", "resolved", "closed"]) });

const WAITLIST_COLS = ["id", "email", "name", "interest", "created_at"];
const TICKET_COLS = ["ticket_id", "name", "email", "topic", "message", "status", "created_at", "updated_at"];

export const CSRF_HEADER = "X-Requested-With";
export const CSRF_VALUE = "albena-admin";

/** CSRF defense in depth: state-changing admin requests must carry the custom header (forces a CORS preflight). */
export async function requireCsrfHeader(c: import("hono").Context<AppEnv>, next: () => Promise<void>) {
  const m = c.req.method;
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS" && c.req.header(CSRF_HEADER) !== CSRF_VALUE) {
    return json({ error: "csrf_header_required" }, 403);
  }
  await next();
}

const auditPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().min(1).optional(),
});

export const adminApi = new Hono<AppEnv>();
adminApi.use("*", requireAccess);
adminApi.use("*", requireCsrfHeader);

adminApi.get("/waitlist", async (c) => {
  const q = pageSchema.safeParse(c.req.query());
  if (!q.success) return json({ error: "invalid_query" }, 400);
  const { results } = await c.env.DB.prepare(
    "SELECT id, email, name, interest, created_at FROM waitlist ORDER BY id DESC LIMIT ? OFFSET ?",
  ).bind(q.data.limit, q.data.offset).all();
  await audit(c.env, { actor: c.get("actor"), action: "admin.waitlist.list", requestId: c.get("requestId"), ipHash: c.get("ipHash") });
  return json({ items: results, limit: q.data.limit, offset: q.data.offset });
});

adminApi.get("/tickets", async (c) => {
  const q = pageSchema.safeParse(c.req.query());
  if (!q.success) return json({ error: "invalid_query" }, 400);
  const sql =
    "SELECT ticket_id, name, email, topic, message, status, created_at, updated_at FROM tickets " +
    (q.data.status ? "WHERE status = ? " : "") +
    "ORDER BY id DESC LIMIT ? OFFSET ?";
  const args = q.data.status ? [q.data.status, q.data.limit, q.data.offset] : [q.data.limit, q.data.offset];
  const { results } = await c.env.DB.prepare(sql).bind(...args).all();
  await audit(c.env, { actor: c.get("actor"), action: "admin.tickets.list", requestId: c.get("requestId"), ipHash: c.get("ipHash") });
  return json({ items: results, limit: q.data.limit, offset: q.data.offset });
});

adminApi.patch("/tickets/:id", async (c) => {
  const m = /^ALB-(\d{1,9})$/.exec(c.req.param("id"));
  if (!m) return json({ error: "invalid_id" }, 400);
  let body: unknown;
  try { body = await c.req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const p = patchSchema.safeParse(body);
  if (!p.success) return json({ error: "validation_failed" }, 400);
  const r = await c.env.DB.prepare(
    "UPDATE tickets SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
  ).bind(p.data.status, Number(m[1])).run();
  if (!r.meta.changes) return json({ error: "not_found" }, 404);
  await audit(c.env, {
    actor: c.get("actor"),
    action: `admin.ticket.status:${p.data.status}`,
    target: `ticket:${c.req.param("id")}`,
    requestId: c.get("requestId"),
    ipHash: c.get("ipHash"),
  });
  return json({ ok: true, id: c.req.param("id"), status: p.data.status });
});

for (const [name, table, cols, order] of [
  ["waitlist", "waitlist", WAITLIST_COLS, "id"],
  ["tickets", "tickets", TICKET_COLS, "id"],
] as const) {
  adminApi.get(`/export/${name}.csv`, async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT ${cols.join(", ")} FROM ${table} ORDER BY ${order} ASC LIMIT 50000`,
    ).all();
    await audit(c.env, { actor: c.get("actor"), action: `admin.export.${name}`, requestId: c.get("requestId"), ipHash: c.get("ipHash") });
    return new Response(toCsv(results as Record<string, unknown>[], [...cols]), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}.csv"`,
      },
    });
  });
}

adminApi.get("/integrity", async (c) => {
  const chain = await verifyChain(c.env);
  const s = await statusSummary(c.env);
  await audit(c.env, { actor: c.get("actor"), action: "admin.integrity", requestId: c.get("requestId"), ipHash: c.get("ipHash") });
  return json({ chain, lastBackupOk: s.lastBackupOk, lastBackupAt: s.lastBackupAt, lastVerifiedAt: s.lastVerifiedAt });
});

/** Read-only audit trail, newest first, keyset-paginated by id. ip_hash and full hashes are never returned. */
adminApi.get("/audit", async (c) => {
  const q = auditPageSchema.safeParse(c.req.query());
  if (!q.success) return json({ error: "invalid_query" }, 400);
  const { limit, before } = q.data;
  const { results } = await c.env.DB.prepare(
    "SELECT id, ts, actor, action, target, request_id, substr(hash, 1, 12) AS hash_prefix FROM audit_log " +
      (before ? "WHERE id < ? " : "") +
      "ORDER BY id DESC LIMIT ?",
  ).bind(...(before ? [before, limit + 1] : [limit + 1])).all<{ id: number }>();
  const hasMore = results.length > limit;
  const items = hasMore ? results.slice(0, limit) : results;
  const next = hasMore ? items[items.length - 1].id : null;
  await audit(c.env, { actor: c.get("actor"), action: "admin.audit.list", requestId: c.get("requestId"), ipHash: c.get("ipHash") });
  return json({ items, limit, next_before: next });
});

/** Runs the same function as the nightly cron, on demand. Behind Access + CSRF like every admin route. */
adminApi.post("/backup/run", async (c) => {
  const meta = { actor: c.get("actor"), requestId: c.get("requestId"), ipHash: c.get("ipHash") };
  await audit(c.env, { ...meta, action: "admin.backup.run" });
  try {
    const m = await runBackup(c.env);
    return json({ ok: true, date: m.date, tables: Object.fromEntries(Object.entries(m.tables).map(([k, v]) => [k, v.rows])) });
  } catch (e) {
    console.error("manual backup failed", e instanceof Error ? e.message : "unknown");
    await audit(c.env, { actor: "system", action: "backup.failed", requestId: c.get("requestId") }).catch(() => {});
    return json({ ok: false, error: "backup_failed" }, 500);
  }
});

adminApi.post("/backup/verify", async (c) => {
  await audit(c.env, { actor: c.get("actor"), action: "admin.backup.verify", requestId: c.get("requestId"), ipHash: c.get("ipHash") });
  return json(await runVerify(c.env));
});

/** One-shot repair of a concurrent-sealer fork; refuses unless the chain is broken by prev_hash linkage only. */
adminApi.post("/audit/repair", async (c) => {
  const r = await repairChain(c.env, c.get("actor"), c.get("requestId"));
  if ("error" in r) return json(r, 409);
  return json({ ok: true, ...r, chain: await verifyChain(c.env) });
});

adminApi.all("*", () => json({ error: "not_found" }, 404));
