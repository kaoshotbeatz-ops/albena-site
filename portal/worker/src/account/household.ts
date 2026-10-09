import type { Context, Hono } from "hono";
import type { AppEnv } from "../types";
import { audit, requireUser } from "../auth";
import { EMAIL_RE } from "../auth/magic";
import { allowed } from "../auth/limits";
import { sendNotice } from "../auth/mail";

export const MEMBER_INVITE_TTL_S = 14 * 24 * 3600;
const MAX_PENDING = 10;
const now = () => Math.floor(Date.now() / 1000);

/** An account with nothing in it besides its owner: safe to drop when the owner joins a household instead. */
async function isEmptyAccount(db: D1Database, accountId: string, ownerId: string): Promise<boolean> {
  const r = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM members WHERE account_id = ?1 AND user_id <> ?2) + (SELECT COUNT(*) FROM hubs WHERE account_id = ?1)
          + (SELECT COUNT(*) FROM hardware_orders WHERE account_id = ?1) + (SELECT COUNT(*) FROM billing_customers WHERE account_id = ?1)
          + (SELECT COUNT(*) FROM entitlements WHERE account_id = ?1) + (SELECT COUNT(*) FROM license_keys WHERE account_id = ?1)
          + (SELECT COUNT(*) FROM reserved_hubs WHERE account_id = ?1) + (SELECT COUNT(*) FROM account_notes WHERE account_id = ?1) AS n`,
  ).bind(accountId, ownerId).first<{ n: number }>();
  return (r?.n ?? 1) === 0;
}

/**
 * Called when someone signs in with the magic link/code: a pending household invite for this email makes them a member of that account.
 * A person who already runs a real account of their own keeps it (there is no account switching yet) and the invite stays pending;
 * an untouched, just-created account is dropped so they land in the household. Returns the joined account id.
 */
export async function joinHousehold(c: Context<AppEnv>, userId: string, email: string): Promise<string | null> {
  const db = c.env.DB, ts = now();
  const inv = await db.prepare(
    "SELECT id, account_id FROM member_invites WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? AND EXISTS (SELECT 1 FROM accounts WHERE id = member_invites.account_id) ORDER BY created_at LIMIT 1",
  ).bind(email, ts).first<{ id: string; account_id: string }>();
  if (!inv) return null;
  const own = await db.prepare("SELECT id FROM accounts WHERE owner = ?").bind(userId).first<{ id: string }>();
  if (own && own.id !== inv.account_id && !(await isEmptyAccount(db, own.id, userId))) return null;
  const stmts = [];
  if (own && own.id !== inv.account_id) {
    stmts.push(
      db.prepare("DELETE FROM sessions WHERE account_id = ?").bind(own.id),
      db.prepare("DELETE FROM members WHERE account_id = ?").bind(own.id),
      db.prepare("DELETE FROM accounts WHERE id = ?").bind(own.id),
    );
  }
  stmts.push(
    db.prepare("INSERT OR IGNORE INTO members (account_id, user_id, role) VALUES (?, ?, 'member')").bind(inv.account_id, userId),
    db.prepare("UPDATE member_invites SET accepted_at = ? WHERE email = ? AND account_id = ? AND accepted_at IS NULL AND revoked_at IS NULL").bind(ts, email, inv.account_id),
  );
  await db.batch(stmts);
  await audit(c, "household.invite.accepted", inv.account_id, { inviteId: inv.id, userId });
  return inv.account_id;
}

export function mountHousehold(app: Hono<AppEnv>): void {
  app.post("/api/account/members/invite", requireUser, async (c) => {
    const u = c.get("user");
    if (u.role !== "owner") return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json<{ email?: unknown }>().catch(() => ({} as { email?: unknown }));
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (email.length > 254 || !EMAIL_RE.test(email)) return c.json({ error: "invalid_email" }, 400);
    if (!(await allowed(c, email))) return c.json({ error: "rate_limited" }, 429);
    const db = c.env.DB, ts = now();
    if (await db.prepare("SELECT 1 AS x FROM members m JOIN users x ON x.id = m.user_id WHERE m.account_id = ? AND x.email = ?").bind(u.accountId, email).first())
      return c.json({ error: "already_member" }, 409);
    if (await db.prepare("SELECT 1 AS x FROM member_invites WHERE account_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?").bind(u.accountId, email, ts).first())
      return c.json({ error: "already_invited" }, 409);
    const pending = await db.prepare("SELECT COUNT(*) AS n FROM member_invites WHERE account_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?").bind(u.accountId, ts).first<{ n: number }>();
    if ((pending?.n ?? 0) >= MAX_PENDING) return c.json({ error: "too_many_invites" }, 409);
    const id = crypto.randomUUID();
    await db.prepare("INSERT INTO member_invites (id, account_id, email, invited_by, created_at, expires_at) VALUES (?,?,?,?,?,?)")
      .bind(id, u.accountId, email, u.id, ts, ts + MEMBER_INVITE_TTL_S).run();
    try {
      await sendNotice(c.env, {
        to: email, subject: "You're invited to an Albena household",
        text: `${u.email} invited you to join their Albena household.\n\nSign in with this email address (${email}) at ${c.env.PORTAL_ORIGIN}/login and you will be added to their account. The invitation expires in 14 days. If you were not expecting this, ignore this email.`,
      });
    } catch {
      await db.prepare("DELETE FROM member_invites WHERE id = ?").bind(id).run();
      return c.json({ error: "mail_failed" }, 502);
    }
    await audit(c, "household.invite.create", u.accountId, { inviteId: id });
    return c.json({ invite: { id, email, expiresAt: ts + MEMBER_INVITE_TTL_S } }, 201);
  });

  app.delete("/api/account/members/invites/:id", requireUser, async (c) => {
    const u = c.get("user");
    if (u.role !== "owner") return c.json({ error: "forbidden" }, 403);
    const r = await c.env.DB.prepare("UPDATE member_invites SET revoked_at = ? WHERE id = ? AND account_id = ? AND accepted_at IS NULL AND revoked_at IS NULL")
      .bind(now(), c.req.param("id"), u.accountId).run();
    if (!r.meta?.changes) return c.json({ error: "not_found" }, 404);
    await audit(c, "household.invite.revoke", u.accountId, { inviteId: c.req.param("id") });
    return c.json({ ok: true });
  });

  app.delete("/api/account/members/:userId", requireUser, async (c) => {
    const u = c.get("user");
    if (u.role !== "owner") return c.json({ error: "forbidden" }, 403);
    const target = c.req.param("userId");
    const db = c.env.DB;
    const r = await db.batch([
      db.prepare("DELETE FROM sessions WHERE account_id = ?1 AND user_id = ?2 AND EXISTS (SELECT 1 FROM members WHERE account_id = ?1 AND user_id = ?2 AND role = 'member')").bind(u.accountId, target),
      db.prepare("DELETE FROM members WHERE account_id = ?1 AND user_id = ?2 AND role = 'member'").bind(u.accountId, target),
    ]);
    if (!r[1].meta?.changes) return c.json({ error: "not_found" }, 404);
    await audit(c, "household.member.remove", u.accountId, { userId: target });
    return c.json({ ok: true });
  });
}
