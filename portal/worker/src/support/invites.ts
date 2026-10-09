import type { Context, Hono } from "hono";
import type { AppEnv } from "../types";
import { audit } from "../auditchain";
import { EMAIL_RE, startMagic } from "../auth/magic";
import { allowed, turnstile } from "../auth/limits";
import { equalHash, randomToken, sha256 } from "../auth/crypto";
import { sendNotice } from "../auth/mail";
import { getEntitlement, recordHistory, writeManualEntitlement } from "../billing/entitlements";
import { DAY, now, parsePlanFields, readObj, text, type Obj } from "./grant";

type C = Context<AppEnv>;
export const INVITE_TTL_S = 14 * DAY;
const MAX_ATTEMPTS = 5;
const MIN_RESEND_S = 60;
const BULK_MAX = 50;

const link = (c: C, id: string, secret: string) => `${c.env.PORTAL_ORIGIN}/invite?token=${id}.${secret}`;
const mailBody = (url: string) =>
  `You're invited to Albena.\n\nOpen this link to set up your account: ${url}\n\nYou will be asked to confirm this email address, then we send a normal sign-in email to it. The link works once and expires in 14 days. If you were not expecting this, ignore this email.`;

const statusOf = (r: { accepted_at: number | null; revoked_at: number | null; expires_at: number }, ts: number) =>
  r.accepted_at ? "accepted" : r.revoked_at ? "revoked" : r.expires_at <= ts ? "expired" : "pending";

type Made = { ok: true; id: string } | { ok: false; status: 400 | 409 | 502; error: string; accountId?: string };

/** Creates an invite row and mails it; on delivery failure the row is removed so the same email can be retried. */
async function createInvite(c: C, email: string, b: Obj): Promise<Made> {
  const db = c.env.DB, ts = now();
  if (email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, status: 400, error: "invalid_email" };
  let plan: string | null = null, basePlan: string | null = null, days: number | null = null;
  if (b.plan !== undefined && b.plan !== null) {
    const f = parsePlanFields(b);
    if ("error" in f) return { ok: false, status: 400, error: f.error };
    plan = f.plan; basePlan = f.basePlan; days = f.days;
  }
  const note = b.note === undefined || b.note === null ? null : text(b.note, 500);
  if (b.note !== undefined && b.note !== null && note === null) return { ok: false, status: 400, error: "invalid_note" };
  const existing = await db.prepare("SELECT u.id, (SELECT account_id FROM members WHERE user_id = u.id ORDER BY (role = 'owner') DESC LIMIT 1) AS accountId FROM users u WHERE u.email = ?").bind(email).first<{ accountId: string | null }>();
  if (existing?.accountId) return { ok: false, status: 409, error: "already_customer", accountId: existing.accountId };
  if (await db.prepare("SELECT 1 AS x FROM invites WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?").bind(email, ts).first())
    return { ok: false, status: 409, error: "invite_pending" };
  const id = crypto.randomUUID(), secret = randomToken();
  await db.prepare("INSERT INTO invites (id, email, token_hash, plan, base_plan, days, note, invited_by, created_at, expires_at, last_sent_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, email, await sha256(secret), plan, basePlan, days, note, `support:${c.get("supportActor")}`, ts, ts + INVITE_TTL_S, ts).run();
  try {
    await sendNotice(c.env, { to: email, subject: "You're invited to Albena", text: mailBody(link(c, id, secret)) });
  } catch {
    await db.prepare("DELETE FROM invites WHERE id = ?").bind(id).run();
    return { ok: false, status: 502, error: "mail_failed" };
  }
  await audit(c, "support.invite.create", id, { plan });
  return { ok: true, id };
}

/** Staff invite API (behind Access) plus the public accept endpoint. */
export function mountInvites(app: Hono<AppEnv>): void {
  app.get("/api/support/invites", async (c) => {
    const ts = now();
    const { results } = await c.env.DB.prepare(
      "SELECT id, email, plan, days, note, invited_by AS invitedBy, created_at AS createdAt, expires_at AS expiresAt, accepted_at AS acceptedAt, revoked_at AS revokedAt, account_id AS accountId, send_count AS sendCount, last_sent_at AS lastSentAt, attempts FROM invites ORDER BY created_at DESC LIMIT 300",
    ).all<any>();
    return c.json({ invites: results.map((r) => ({ ...r, status: statusOf({ accepted_at: r.acceptedAt, revoked_at: r.revokedAt, expires_at: r.expiresAt }, ts) })) });
  });

  app.post("/api/support/invites", async (c) => {
    const b = await readObj(c);
    const r = await createInvite(c, typeof b.email === "string" ? b.email.trim().toLowerCase() : "", b);
    if (!r.ok) return c.json({ error: r.error, ...(r.accountId ? { accountId: r.accountId } : {}) }, r.status);
    return c.json({ invite: { id: r.id } }, 201);
  });

  // "Paste emails": one plan/note for the whole list, a result per address.
  app.post("/api/support/invites/bulk", async (c) => {
    const b = await readObj(c);
    const raw = Array.isArray(b.emails) ? b.emails : [];
    if (!raw.length || raw.length > BULK_MAX || raw.some((e) => typeof e !== "string")) return c.json({ error: "invalid_emails" }, 400);
    const emails = [...new Set((raw as string[]).map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const results: { email: string; ok: boolean; error?: string; id?: string }[] = [];
    for (const email of emails) {
      const r = await createInvite(c, email, b);
      results.push(r.ok ? { email, ok: true, id: r.id } : { email, ok: false, error: r.error });
    }
    return c.json({ results });
  });

  app.post("/api/support/invites/:id/resend", async (c) => {
    const db = c.env.DB, ts = now(), id = c.req.param("id");
    const inv = await db.prepare("SELECT email, accepted_at, revoked_at, last_sent_at FROM invites WHERE id = ?").bind(id).first<{ email: string; accepted_at: number | null; revoked_at: number | null; last_sent_at: number }>();
    if (!inv) return c.json({ error: "not_found" }, 404);
    if (inv.accepted_at || inv.revoked_at) return c.json({ error: "invite_closed" }, 409);
    if (ts - inv.last_sent_at < MIN_RESEND_S) return c.json({ error: "too_soon" }, 429);
    // A new secret replaces the old one: the previous email's link stops working.
    const secret = randomToken();
    const r = await db.prepare(
      "UPDATE invites SET token_hash = ?, expires_at = ?, attempts = 0, send_count = send_count + 1, last_sent_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND last_sent_at <= ? RETURNING email",
    ).bind(await sha256(secret), ts + INVITE_TTL_S, ts, id, ts - MIN_RESEND_S).first<{ email: string }>();
    if (!r) return c.json({ error: "too_soon" }, 429);
    try {
      await sendNotice(c.env, { to: r.email, subject: "You're invited to Albena", text: mailBody(link(c, id, secret)) });
    } catch {
      return c.json({ error: "mail_failed" }, 502);
    }
    await audit(c, "support.invite.resend", id);
    return c.json({ ok: true });
  });

  app.delete("/api/support/invites/:id", async (c) => {
    const r = await c.env.DB.prepare("UPDATE invites SET revoked_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id").bind(now(), c.req.param("id")).first();
    if (!r) return c.json({ error: "not_found" }, 404);
    await audit(c, "support.invite.revoke", c.req.param("id"));
    return c.json({ ok: true });
  });

  /**
   * Public. Possession of the emailed link is not enough: the visitor must also type the invited address, and the account is only
   * usable after the normal magic sign-in email to that address (same-browser bound). The invite is consumed here, once.
   */
  app.post("/api/invite/accept", async (c) => {
    const b = await readObj(c);
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    const token = typeof b.token === "string" ? b.token : "";
    const [id, secret, extra] = token.split(".");
    if (email.length > 254 || !EMAIL_RE.test(email) || typeof b.turnstileToken !== "string" || b.turnstileToken.length > 2048 ||
        extra !== undefined || !id || !/^[a-f0-9-]{36}$/.test(id) || !secret || !/^[a-f0-9]{64}$/.test(secret)) return c.json({ error: "invalid_request" }, 400);
    if (!(await allowed(c, email))) return c.json({ error: "rate_limited" }, 429);
    if (!(await turnstile(c, b.turnstileToken))) return c.json({ error: "challenge_failed" }, 400);
    const db = c.env.DB, ts = now();
    const bad = () => c.json({ error: "invalid_or_expired_invite" }, 400);
    const inv = await db.prepare("SELECT email, token_hash, plan, base_plan, days, note, expires_at, accepted_at, revoked_at, attempts FROM invites WHERE id = ?").bind(id)
      .first<{ email: string; token_hash: string; plan: string | null; base_plan: string | null; days: number | null; note: string | null; expires_at: number; accepted_at: number | null; revoked_at: number | null; attempts: number }>();
    const hash = await sha256(secret);
    if (!inv || !equalHash(hash, inv.token_hash) || statusOf(inv, ts) !== "pending") return bad();
    if (inv.attempts >= MAX_ATTEMPTS) return c.json({ error: "invite_locked" }, 429);
    if (inv.email.toLowerCase() !== email) {
      await db.prepare("UPDATE invites SET attempts = attempts + 1 WHERE id = ?").bind(id).run();
      return c.json({ error: "email_mismatch" }, 400);
    }
    // Single-use gate, including simultaneous requests.
    const used = await db.prepare("UPDATE invites SET accepted_at = ? WHERE id = ? AND token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? RETURNING id")
      .bind(ts, id, hash, ts).first();
    if (!used) return bad();

    const userId = crypto.randomUUID();
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)").bind(userId, email),
      db.prepare("INSERT OR IGNORE INTO accounts (id, owner) SELECT id, id FROM users WHERE email = ? AND NOT EXISTS (SELECT 1 FROM members WHERE user_id = users.id)").bind(email),
      db.prepare("INSERT OR IGNORE INTO members (account_id, user_id, role) SELECT a.id, u.id, 'owner' FROM users u JOIN accounts a ON a.owner = u.id WHERE u.email = ?").bind(email),
    ]);
    const acct = await db.prepare("SELECT a.id FROM accounts a JOIN users u ON u.id = a.owner WHERE u.email = ?").bind(email).first<{ id: string }>();
    if (acct) {
      await db.prepare("UPDATE invites SET account_id = ? WHERE id = ?").bind(acct.id, id).run();
      // Pre-create the entitlement unless the account already has a live one (never downgrade or replace a paying customer).
      if (inv.plan && !(await getEntitlement(db, acct.id)).active) {
        const f = parsePlanFields({ plan: inv.plan, basePlan: inv.base_plan, ...(inv.days ? { days: inv.days } : {}) });
        if (!("error" in f)) {
          const endsAt = f.days ? ts + f.days * DAY : null;
          if (await writeManualEntitlement(db, acct.id, { plan: f.stored, status: "active", endsAt, note: inv.note, maxHubs: null, comp: f.comp })) {
            await recordHistory(db, { accountId: acct.id, actor: "invite", kind: "grant", source: "manual", plan: f.comp ? `comp:${f.stored}` : f.stored, status: "active", endsAt, note: inv.note });
          }
        }
      }
      await audit(c, "invite.accepted", id, { accountId: acct.id });
    }
    // The ordinary sign-in email goes out; it carries the cookie that ties the link to this browser.
    await startMagic(c, email);
    return c.json({ ok: true, message: "Check your email for a sign-in link and code." }, 202);
  });
}
