import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./types";
import { json } from "./security";
import { statusSummary } from "./maintenance";
import { sealAudit } from "./auditchain";
import { audit, clean, clientIp, hashIp, normalizeEmail, notify, verifyTurnstile } from "./util";

const MAX_BODY = 16 * 1024;

const email = z.string().max(254).transform((s) => s.trim()).pipe(z.email());
const token = z.string().min(1).max(2048);
const optText = (max: number) =>
  z.string().max(max).transform((s) => clean(s)).optional().transform((s) => s || undefined);

export const waitlistSchema = z.object({
  email,
  name: optText(100),
  interest: optText(200),
  turnstileToken: token,
});

export const TOPICS = ["waitlist", "connectors", "privacy", "bug", "accessibility", "security", "other"] as const;

export const supportSchema = z.object({
  name: z.string().max(100).transform((s) => clean(s)).pipe(z.string().min(1)),
  email,
  topic: z.enum(TOPICS),
  message: z.string().max(4000).transform((s) => clean(s, true)).pipe(z.string().min(1)),
  turnstileToken: token,
});

export const publicApi = new Hono<AppEnv>();

/** Read the body as UTF-8, aborting once more than `max` bytes arrive. Null = too large. */
async function readLimited(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) { buf.set(ch, off); off += ch.byteLength; }
  return new TextDecoder().decode(buf);
}

publicApi.get("/health", (c) => json({ ok: true, ts: new Date().toISOString() }));
publicApi.get("/config", (c) => json({ turnstileSiteKey: c.env.TURNSTILE_SITE_KEY }));

// Guards shared by POST endpoints: same-origin, rate limit, JSON body parse.
publicApi.post("*", async (c, next) => {
  const origin = c.req.header("Origin");
  if (origin && origin !== new URL(c.req.url).origin) return json({ error: "forbidden" }, 403);

  const ip = clientIp(c.req.raw);
  const { success } = await c.env.POST_LIMITER.limit({ key: `${ip}:${new URL(c.req.url).pathname}` });
  if (!success) return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });

  if (!(c.req.header("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    return json({ error: "unsupported_media_type" }, 415);
  }
  const declared = c.req.header("Content-Length");
  if (declared !== undefined && !(Number(declared) <= MAX_BODY)) return json({ error: "payload_too_large" }, 413);
  const text = await readLimited(c.req.raw, MAX_BODY);
  if (text === null) return json({ error: "payload_too_large" }, 413);
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    c.set("body", parsed);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  c.set("ipHash", await hashIp(c.env, ip));
  c.set("actor", "public");
  await next();
});

async function guard(
  c: import("hono").Context<AppEnv>,
  schema: z.ZodType<{ turnstileToken: string }>,
  what: "waitlist" | "support",
): Promise<{ res: Response } | { data: any }> {
  const raw = c.get("body");
  const ipHash = c.get("ipHash");
  const requestId = c.get("requestId");
  const hp = raw.website;
  if (typeof hp === "string" ? hp.trim() !== "" : hp != null && hp !== false) {
    await audit(c.env, { actor: "public", action: `${what}.honeypot`, requestId, ipHash });
    return { res: json({ ok: true }, 200) }; // look successful to bots
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { res: json({ error: "validation_failed", fields: parsed.error.issues.map((i) => i.path.join(".")) }, 400) };
  }
  const t = await verifyTurnstile(c.env, parsed.data.turnstileToken, clientIp(c.req.raw), what);
  if (t === "unavailable") return { res: json({ error: "verification_unavailable" }, 503) };
  if (t === "failed") {
    await audit(c.env, { actor: "public", action: `${what}.turnstile_failed`, requestId, ipHash });
    return { res: json({ error: "turnstile_failed" }, 403) };
  }
  return { data: parsed.data };
}

publicApi.post("/waitlist", async (c) => {
  const g = await guard(c, waitlistSchema, "waitlist");
  if ("res" in g) return g.res;
  const d = g.data as z.infer<typeof waitlistSchema>;
  const { email: em, key } = normalizeEmail(d.email);
  const [r] = await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO waitlist (email, email_key, name, interest, ip_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email_key) DO NOTHING",
    ).bind(em, key, d.name ?? null, d.interest ?? null, c.get("ipHash")),
    c.env.DB.prepare(
      `INSERT INTO audit_log (actor, action, target, request_id, ip_hash) VALUES ('public',
        CASE WHEN changes() > 0 THEN 'waitlist.create' ELSE 'waitlist.duplicate' END,
        CASE WHEN changes() > 0 THEN 'waitlist:' || last_insert_rowid() END, ?, ?)`,
    ).bind(c.get("requestId"), c.get("ipHash")),
  ]);
  await sealAudit(c.env);
  const created = r.meta.changes > 0;
  if (created) c.executionCtx.waitUntil(notify(c.env, "New Albena waitlist signup", "A new waitlist signup was recorded."));
  return json({ ok: true }, created ? 201 : 200);
});

publicApi.post("/support", async (c) => {
  const g = await guard(c, supportSchema, "support");
  if ("res" in g) return g.res;
  const d = g.data as z.infer<typeof supportSchema>;
  // One atomic batch: ticket row, read back its generated id, audit row.
  const [, sel] = await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO tickets (name, email, topic, message, ip_hash) VALUES (?, ?, ?, ?, ?)",
    ).bind(d.name, normalizeEmail(d.email).email, d.topic, d.message, c.get("ipHash")),
    c.env.DB.prepare("SELECT ticket_id FROM tickets WHERE id = last_insert_rowid()"),
    c.env.DB.prepare(
      `INSERT INTO audit_log (actor, action, target, request_id, ip_hash)
       VALUES ('public', 'support.create', 'ticket:' || (SELECT ticket_id FROM tickets WHERE id = last_insert_rowid()), ?, ?)`,
    ).bind(c.get("requestId"), c.get("ipHash")),
  ]);
  await sealAudit(c.env);
  const id = (sel.results[0] as { ticket_id: string }).ticket_id;
  c.executionCtx.waitUntil(notify(c.env, `New Albena support ticket ${id}`, `Ticket ${id} (${d.topic}) was opened.`));
  return json({ ok: true, id }, 201);
});

/** AU-6/SI-4: public, PII-free health of backups. No counts. */
publicApi.get("/status", async (c) => {
  const s = await statusSummary(c.env);
  return json({ ok: true, lastBackupOk: s.lastBackupOk, lastVerifiedAt: s.lastVerifiedAt });
});
