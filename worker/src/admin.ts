import { createRemoteJWKSet, jwtVerify } from "jose";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "./types";
import { audit } from "./util";
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

export const adminApi = new Hono<AppEnv>();
adminApi.use("*", requireAccess);

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

adminApi.all("*", () => json({ error: "not_found" }, 404));
