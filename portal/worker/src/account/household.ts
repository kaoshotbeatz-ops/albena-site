import type { Context, Hono } from "hono";
import type { AppEnv } from "../types";
import { audit, requireUser } from "../auth";
import { EMAIL_RE } from "../auth/magic";
import { allowed } from "../auth/limits";
import { sendNotice } from "../auth/mail";
import { composeHousehold } from "../auth/compose";

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

type Invite = { id: string; account_id: string };
/** The pending, unexpired invite with this id addressed to this user's email (the invite never applies by itself at sign-in). */
const pendingInvite = (db: D1Database, id: string, email: string) => db.prepare(
  "SELECT id, account_id FROM member_invites WHERE id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? AND EXISTS (SELECT 1 FROM accounts WHERE id = member_invites.account_id)",
).bind(id, email, now()).first<Invite>();

export function mountHousehold(app: Hono<AppEnv>): void {
  // Invitations waiting for the signed-in user to accept or decline.
  app.get("/api/account/invitations", requireUser, async (c) => {
    const u = c.get("user");
    const { results } = await c.env.DB.prepare(
      `SELECT i.id, o.email AS inviterEmail, i.expires_at AS expiresAt FROM member_invites i
         JOIN accounts a ON a.id = i.account_id JOIN users o ON o.id = a.owner
        WHERE i.email = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ? AND i.account_id <> ? ORDER BY i.created_at`,
    ).bind(u.email, now(), u.accountId).all();
    return c.json({ invitations: results });
  });

  // Explicit consent. CSRF is enforced for every non-GET /api request; a read-only view-as session cannot reach it.
  app.post("/api/account/invitations/:id/accept", requireUser, async (c) => {
    const u = c.get("user"), db = c.env.DB, ts = now();
    const inv = await pendingInvite(db, c.req.param("id"), u.email);
    if (!inv) return c.json({ error: "not_found" }, 404);
    if (await db.prepare("SELECT 1 AS x FROM members WHERE account_id = ? AND user_id = ?").bind(inv.account_id, u.id).first()) return c.json({ error: "already_member" }, 409);
    // Only an owner of an untouched account can switch (there is no account switching yet); anything with real data keeps its account.
    const own = await db.prepare("SELECT id FROM accounts WHERE owner = ?").bind(u.id).first<{ id: string }>();
    const drop = own && own.id !== inv.account_id ? own.id : null;
    if (drop && !(await isEmptyAccount(db, drop, u.id))) return c.json({ error: "account_not_empty" }, 409);
    const stmts = [
      db.prepare("INSERT OR IGNORE INTO members (account_id, user_id, role) VALUES (?, ?, 'member')").bind(inv.account_id, u.id),
      db.prepare("UPDATE member_invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL").bind(ts, inv.id),
    ];
    if (drop) stmts.push(
      // The caller's sessions follow them into the household; support view-as sessions on the dropped account end.
      db.prepare("DELETE FROM sessions WHERE account_id = ? AND view_as = 1").bind(drop),
      db.prepare("UPDATE sessions SET account_id = ? WHERE account_id = ? AND user_id = ?").bind(inv.account_id, drop, u.id),
      db.prepare("DELETE FROM members WHERE account_id = ? AND user_id = ?").bind(drop, u.id),
      db.prepare("DELETE FROM accounts WHERE id = ?").bind(drop),
    );
    await db.batch(stmts);
    await audit(c, "household.invite.accepted", inv.account_id, { inviteId: inv.id, userId: u.id, droppedEmptyAccount: drop !== null });
    return c.json({ ok: true, accountId: inv.account_id });
  });

  app.post("/api/account/invitations/:id/decline", requireUser, async (c) => {
    const u = c.get("user");
    const r = await c.env.DB.prepare("UPDATE member_invites SET revoked_at = ? WHERE id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL")
      .bind(now(), c.req.param("id"), u.email).run();
    if (!r.meta?.changes) return c.json({ error: "not_found" }, 404);
    await audit(c, "household.invite.declined", u.accountId, { inviteId: c.req.param("id") });
    return c.json({ ok: true });
  });

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
      await sendNotice(c.env, { to: email, ...composeHousehold(u.email, email, `${c.env.PORTAL_ORIGIN}/login`) });
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
