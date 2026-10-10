import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { audit, requireUser } from "../auth";
import { clearSession } from "../auth/sessions";
import { getEntitlement } from "../billing/entitlements";
import { cancelOpenBilling, listOpenBilling } from "../billing/open";
import { mountHousehold } from "./household";

export const migrations: string[] = [];

async function stripeBackedActive(db: D1Database, accountId: string): Promise<boolean> {
  const ent = await getEntitlement(db, accountId);
  return ent.active && ent.source === "stripe";
}

/** Account read/export/delete, and household invitations (./household.ts). */
export function mount(app: Hono<AppEnv>): void {
  app.get("/api/account", requireUser, async (c) => {
    const { accountId } = c.get("user");
    const account = await c.env.DB.prepare("SELECT id, created_at AS createdAt FROM accounts WHERE id = ?").bind(accountId).first();
    const { results } = await c.env.DB.prepare(
      "SELECT u.id, u.email, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.account_id = ? ORDER BY (m.role = 'owner') DESC, u.email",
    ).bind(accountId).all();
    // Pending household invitations are visible to the owner only.
    const invites = c.get("user").role === "owner"
      ? (await c.env.DB.prepare("SELECT id, email, created_at AS createdAt, expires_at AS expiresAt FROM member_invites WHERE account_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at")
        .bind(accountId, Math.floor(Date.now() / 1000)).all()).results
      : [];
    // Connectors live on the Hub, never in the portal, so this is always empty here.
    return c.json({ account, members: results.map((m) => ({ ...m, status: "active" })), invites, connectors: [] });
  });

  mountHousehold(app);

  app.get("/api/account/export", requireUser, async (c) => {
    const u = c.get("user");
    if (u.role !== "owner") return c.json({ error: "forbidden" }, 403);
    const q = async (sql: string) => (await c.env.DB.prepare(sql).bind(u.accountId).all()).results;
    const data = {
      exportedAt: new Date().toISOString(),
      account: (await q("SELECT id, created_at AS createdAt FROM accounts WHERE id = ?"))[0] ?? null,
      members: await q("SELECT u.id, u.email, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.account_id = ?"),
      entitlement: await getEntitlement(c.env.DB, u.accountId),
      hubs: await q("SELECT id, name, edition, profile, version, update_channel AS updateChannel, remote_access AS remoteAccess, last_seen AS lastSeen, created_at AS createdAt FROM hubs WHERE account_id = ?"),
      orders: await q("SELECT id, plan, source, edition, carrier, tracking, shipping_status AS shippingStatus, refunded, refund_status AS refundStatus, amount_total AS amountTotal, currency, shipping_json AS shipping, created_at AS createdAt FROM hardware_orders WHERE account_id = ?"),
      passkeys: (await c.env.DB.prepare("SELECT id, created_at AS createdAt FROM passkeys WHERE user_id = ?").bind(u.id).all()).results,
    };
    await audit(c, "account.export", u.accountId);
    return c.json(data);
  });

  app.post("/api/account/delete", requireUser, async (c) => {
    const u = c.get("user");
    if (u.role !== "owner") return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json<{ confirm?: unknown; cancelBilling?: unknown }>().catch(() => ({} as { confirm?: unknown; cancelBilling?: unknown }));
    if (body.confirm !== "DELETE") return c.json({ error: "confirmation_required" }, 400);
    // Deleting the account removes our link to Stripe, so nothing that can still bill may be left behind.
    // Stripe (not our entitlement row) is asked, because past_due / incomplete subscriptions keep invoicing.
    const cust = (await c.env.DB.prepare("SELECT stripe_customer_id AS id FROM billing_customers WHERE account_id = ?").bind(u.accountId).first<{ id: string }>())?.id;
    if (cust) {
      try {
        const open = await listOpenBilling(c.env, cust);
        if (open.subscriptions.length || open.checkoutSessions.length) {
          if (body.cancelBilling !== true) return c.json({ error: "billing_active", ...open }, 409);
          if (!(await cancelOpenBilling(c.env, cust, open))) return c.json({ error: "cancel_failed" }, 502);
          await audit(c, "account.billing_canceled", u.accountId, { subscriptions: open.subscriptions.length, checkoutSessions: open.checkoutSessions.length });
        }
      } catch {
        return c.json({ error: "stripe_error" }, 502); // cannot prove billing is closed: do not delete
      }
    } else if (await stripeBackedActive(c.env.DB, u.accountId)) { // a staff-granted (manual) plan has nothing at Stripe to cancel
      return c.json({ error: "billing_active", subscriptions: [], checkoutSessions: [] }, 409);
    }
    // Audit first: the chain keeps only the nonsecret user id and a keyed IP hash, never the email.
    await audit(c, "account.delete", u.accountId);
    const a = u.accountId, id = u.id, db = c.env.DB;
    await db.batch([
      db.prepare("DELETE FROM sessions WHERE account_id = ? OR user_id = ?").bind(a, id),
      db.prepare("DELETE FROM auth_challenges WHERE user_id = ?").bind(id),
      db.prepare("DELETE FROM passkeys WHERE user_id = ?").bind(id),
      db.prepare("DELETE FROM hub_nonces WHERE hub_id IN (SELECT id FROM hubs WHERE account_id = ?)").bind(a),
      db.prepare("DELETE FROM hub_metrics WHERE hub_id IN (SELECT id FROM hubs WHERE account_id = ?)").bind(a),
      db.prepare("DELETE FROM hubs WHERE account_id = ?").bind(a),
      db.prepare("DELETE FROM hub_pair_codes WHERE account_id = ?").bind(a),
      db.prepare("DELETE FROM reserved_hubs WHERE account_id = ?").bind(a),
      db.prepare("DELETE FROM license_keys WHERE account_id = ?").bind(a),
      db.prepare("DELETE FROM member_invites WHERE account_id = ? OR email = ?").bind(a, u.email),
      db.prepare("DELETE FROM entitlement_history WHERE account_id = ?").bind(a),
      db.prepare("DELETE FROM invites WHERE account_id = ? OR email = ?").bind(a, u.email),
      db.prepare("DELETE FROM entitlements WHERE account_id = ?").bind(a),
      db.prepare("DELETE FROM checkout_pending WHERE account_id = ?").bind(a),
      db.prepare("DELETE FROM billing_customers WHERE account_id = ?").bind(a),
      // Order rows are kept for accounting; the shipping address is personal data and goes.
      db.prepare("UPDATE hardware_orders SET shipping_json = NULL, staff_notes = NULL, tracking = NULL WHERE account_id = ?").bind(a),
      db.prepare("DELETE FROM magic_tokens WHERE email = ?").bind(u.email),
      db.prepare("DELETE FROM members WHERE account_id = ? OR user_id = ?").bind(a, id),
      db.prepare("DELETE FROM accounts WHERE id = ?").bind(a),
      db.prepare("DELETE FROM account_notes WHERE account_id = ?").bind(a), // append-only trigger allows this once the account is gone
      db.prepare("DELETE FROM users WHERE id = ?").bind(id),
    ]);
    clearSession(c);
    return c.json({ ok: true });
  });
}
