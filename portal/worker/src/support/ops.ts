import type { Context, Hono } from "hono";
import type { AppEnv } from "../types";
import { audit } from "../auditchain";
import { getEntitlement } from "../billing/entitlements";
import { EMAIL_RE } from "../auth/magic";
import { b64decodeStrict, b64encode, licenseKeyHash, newLicenseKey } from "../hubs/crypto";
import { SERIAL } from "../hubs/schema";
import { DAY, grantEntitlement, now, readObj, text } from "./grant";

type C = Context<AppEnv>;
const UUID = /^[A-Za-z0-9_-]{8,64}$/;

/** Manual order lifecycle: pending -> preparing -> shipped -> delivered; cancelled while nothing has shipped. */
export const ORDER_NEXT: Record<string, string[]> = { pending: ["preparing", "cancelled"], preparing: ["shipped", "cancelled"], shipped: ["delivered"], delivered: [], cancelled: [] };

/** Staff routes beyond view-as/list. Mounted by ./index.ts behind the Cloudflare Access + allowlist gate. */
export function mountOps(app: Hono<AppEnv>): void {
  const accountExists = async (c: C, id: string) => !!(await c.env.DB.prepare("SELECT 1 AS x FROM accounts WHERE id = ?").bind(id).first());

  app.get("/api/support/accounts/:id", async (c) => {
    const id = c.req.param("id"), db = c.env.DB;
    const acct = await db.prepare("SELECT a.id, a.created_at AS createdAt, u.email AS ownerEmail FROM accounts a JOIN users u ON u.id = a.owner WHERE a.id = ?").bind(id).first<any>();
    if (!acct) return c.json({ error: "not_found" }, 404);
    const q = async (sql: string) => (await db.prepare(sql).bind(id).all()).results;
    const entRow = await db.prepare("SELECT note FROM entitlements WHERE account_id = ?").bind(id).first<{ note: string | null }>();
    const hubs = (await q("SELECT id, name, edition, profile, version, update_channel AS updateChannel, remote_access AS remoteAccess, health_json AS health, last_seen AS lastSeen, created_at AS createdAt FROM hubs WHERE account_id = ? ORDER BY created_at"))
      .map((h: any) => ({ ...h, remoteAccess: !!h.remoteAccess, health: h.health ? JSON.parse(h.health) : null }));
    await audit(c, "support.account.view", id);
    return c.json({
      account: acct,
      users: await q("SELECT u.id, u.email, u.name, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.account_id = ? ORDER BY (m.role = 'owner') DESC, u.email"),
      entitlement: { ...(await getEntitlement(db, id)), note: entRow?.note ?? null },
      history: await q("SELECT id, at, actor, kind, source, plan, status, ends_at AS endsAt, note FROM entitlement_history WHERE account_id = ? ORDER BY id DESC LIMIT 50"),
      hubs,
      reservedHubs: await q("SELECT id, serial, edition, name, created_at AS createdAt, expires_at AS expiresAt, used_at AS usedAt, hub_id AS hubId FROM reserved_hubs WHERE account_id = ? ORDER BY created_at DESC"),
      orders: await q("SELECT id, source, plan, edition, shipping_status AS status, carrier, tracking, staff_notes AS notes, amount_total AS amountTotal, currency, created_at AS createdAt, updated_at AS updatedAt FROM hardware_orders WHERE account_id = ? ORDER BY created_at DESC"),
      licenseKeys: await q("SELECT id, hint, label, created_at AS createdAt, revoked_at AS revokedAt, last_used_at AS lastUsedAt, use_count AS useCount FROM license_keys WHERE account_id = ? ORDER BY created_at DESC"),
      notes: await q("SELECT id, at, actor, body FROM account_notes WHERE account_id = ? ORDER BY id DESC LIMIT 100"),
      invites: await q(`SELECT id, email, plan, created_at AS createdAt, expires_at AS expiresAt, accepted_at AS acceptedAt, revoked_at AS revokedAt, send_count AS sendCount
        FROM invites WHERE account_id = ?1 OR email IN (SELECT u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.account_id = ?1) ORDER BY created_at DESC LIMIT 20`),
      audit: await q(`SELECT id, ts, actor, action, target, meta FROM audit_log
        WHERE target = ?1 OR target IN (SELECT id FROM hubs WHERE account_id = ?1) OR target IN (SELECT id FROM hardware_orders WHERE account_id = ?1)
           OR actor IN (SELECT user_id FROM members WHERE account_id = ?1) ORDER BY id DESC LIMIT 100`),
    });
  });

  // ---- manual customer: user + account (owner) without a login; they sign in later with that email ----
  app.post("/api/support/accounts", async (c) => {
    const b = await readObj(c), db = c.env.DB;
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    if (email.length > 254 || !EMAIL_RE.test(email)) return c.json({ error: "invalid_email" }, 400);
    const name = b.name === undefined ? null : text(b.name, 120);
    if (b.name !== undefined && name === null) return c.json({ error: "invalid_name" }, 400);
    const known = await db.prepare("SELECT u.id, (SELECT account_id FROM members WHERE user_id = u.id ORDER BY (role = 'owner') DESC LIMIT 1) AS accountId FROM users u WHERE u.email = ?").bind(email).first<{ id: string; accountId: string | null }>();
    if (known?.accountId) return c.json({ error: "exists", accountId: known.accountId }, 409);
    const userId = known?.id ?? crypto.randomUUID();
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)").bind(userId, email, name),
      db.prepare("INSERT OR IGNORE INTO accounts (id, owner) VALUES (?, ?)").bind(userId, userId),
      db.prepare("INSERT OR IGNORE INTO members (account_id, user_id, role) VALUES (?, ?, 'owner')").bind(userId, userId),
      ...(name && known ? [db.prepare("UPDATE users SET name = ? WHERE id = ? AND name IS NULL").bind(name, userId)] : []),
    ]);
    await audit(c, "support.account.create", userId, { manual: true });
    let grant: unknown = null;
    if (b.plan !== undefined) {
      const g = await grantEntitlement(c, userId, b);
      if (!g.ok) return c.json({ error: g.error, accountId: userId, created: true }, g.status);
      grant = g.kind;
    }
    return c.json({ accountId: userId, grant }, 201);
  });

  // ---- plans by hand ----
  app.post("/api/support/accounts/:id/entitlement", async (c) => {
    const id = c.req.param("id");
    if (!(await accountExists(c, id))) return c.json({ error: "not_found" }, 404);
    const g = await grantEntitlement(c, id, await readObj(c));
    if (!g.ok) return c.json({ error: g.error }, g.status);
    return c.json({ ok: true, kind: g.kind, entitlement: await getEntitlement(c.env.DB, id) });
  });

  // ---- staff notes (append-only) ----
  app.post("/api/support/accounts/:id/notes", async (c) => {
    const id = c.req.param("id");
    if (!(await accountExists(c, id))) return c.json({ error: "not_found" }, 404);
    const body = text((await readObj(c)).body, 2000);
    if (!body) return c.json({ error: "invalid_note" }, 400);
    const ts = now();
    const r = await c.env.DB.prepare("INSERT INTO account_notes (account_id, at, actor, body) VALUES (?,?,?,?) RETURNING id").bind(id, ts, `support:${c.get("supportActor")}`, body).first<{ id: number }>();
    await audit(c, "support.note.add", id, { noteId: r?.id });
    return c.json({ note: { id: r?.id, at: ts, actor: `support:${c.get("supportActor")}`, body } }, 201);
  });

  // ---- manual hardware orders ----
  app.post("/api/support/accounts/:id/orders", async (c) => {
    const id = c.req.param("id"), b = await readObj(c);
    if (!(await accountExists(c, id))) return c.json({ error: "not_found" }, 404);
    if (b.edition !== "mac" && b.edition !== "nvidia") return c.json({ error: "invalid_edition" }, 400);
    const notes = b.notes === undefined ? null : text(b.notes, 1000);
    if (b.notes !== undefined && notes === null) return c.json({ error: "invalid_notes" }, 400);
    const orderId = `ord_${crypto.randomUUID()}`, ts = now();
    await c.env.DB.prepare(
      `INSERT INTO hardware_orders (id, account_id, plan, checkout_session_id, shipping_status, created_at, source, edition, staff_notes, updated_at, created_by)
       VALUES (?,?,?,?, 'pending', ?, 'manual', ?, ?, ?, ?)`,
    ).bind(orderId, id, b.edition === "mac" ? "hub_mac" : "hub_nvidia", `manual_${orderId}`, ts, b.edition, notes, ts, `support:${c.get("supportActor")}`).run();
    await audit(c, "support.order.create", orderId, { accountId: id, edition: b.edition });
    return c.json({ order: { id: orderId, status: "pending", edition: b.edition } }, 201);
  });

  app.patch("/api/support/orders/:id", async (c) => {
    const id = c.req.param("id"), b = await readObj(c), db = c.env.DB;
    const o = await db.prepare("SELECT id, account_id, source, shipping_status AS status FROM hardware_orders WHERE id = ?").bind(id).first<{ id: string; account_id: string; source: string; status: string }>();
    if (!o) return c.json({ error: "not_found" }, 404);
    if (o.source !== "manual") return c.json({ error: "not_manual" }, 409);
    const notes = b.notes === undefined ? undefined : text(b.notes, 1000);
    if (b.notes !== undefined && notes === null) return c.json({ error: "invalid_notes" }, 400);
    const ts = now();
    if (b.status === undefined) {
      if (notes === undefined) return c.json({ error: "nothing_to_update" }, 400);
      await db.prepare("UPDATE hardware_orders SET staff_notes = ?, updated_at = ? WHERE id = ?").bind(notes, ts, id).run();
      await audit(c, "support.order.note", id);
      return c.json({ ok: true });
    }
    const to = String(b.status);
    if (!ORDER_NEXT[o.status]?.includes(to)) return c.json({ error: "invalid_transition", from: o.status, to }, 409);
    let carrier: string | null = null, tracking: string | null = null;
    if (to === "shipped") {
      carrier = text(b.carrier, 64); tracking = text(b.tracking, 128);
      if (!carrier || !tracking) return c.json({ error: "carrier_and_tracking_required" }, 400);
    }
    // The previous status is part of the WHERE: two staff clicking at once cannot both move the same order.
    const r = await db.prepare(
      `UPDATE hardware_orders SET shipping_status = ?1, updated_at = ?2, carrier = COALESCE(?3, carrier), tracking = COALESCE(?4, tracking),
         shipped_at = CASE WHEN ?1 = 'shipped' THEN ?2 ELSE shipped_at END, delivered_at = CASE WHEN ?1 = 'delivered' THEN ?2 ELSE delivered_at END,
         staff_notes = COALESCE(?5, staff_notes)
       WHERE id = ?6 AND source = 'manual' AND shipping_status = ?7`,
    ).bind(to, ts, carrier, tracking, notes ?? null, id, o.status).run();
    if (!r.meta?.changes) return c.json({ error: "invalid_transition", from: o.status, to }, 409);
    await audit(c, `support.order.${to}`, id, { accountId: o.account_id });
    return c.json({ ok: true, status: to });
  });

  // ---- pre-provisioned Hubs ----
  app.post("/api/support/accounts/:id/reserved-hubs", async (c) => {
    const id = c.req.param("id"), b = await readObj(c);
    if (!(await accountExists(c, id))) return c.json({ error: "not_found" }, 404);
    const serial = typeof b.serial === "string" ? b.serial.trim().toUpperCase() : "";
    if (!SERIAL.test(serial)) return c.json({ error: "invalid_serial" }, 400);
    if (b.edition !== "mac" && b.edition !== "nvidia") return c.json({ error: "invalid_edition" }, 400);
    const name = b.name === undefined ? null : text(b.name, 60);
    if (b.name !== undefined && name === null) return c.json({ error: "invalid_name" }, 400);
    let publicKey: string | null = null;
    if (b.publicKey !== undefined) {
      const k = b64decodeStrict(b.publicKey);
      if (!k || k.length !== 32) return c.json({ error: "invalid_public_key" }, 400);
      publicKey = b64encode(k);
    }
    const days = b.days === undefined ? 60 : b.days;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 365) return c.json({ error: "invalid_days" }, 400);
    const rid = crypto.randomUUID(), ts = now();
    try {
      await c.env.DB.prepare("INSERT INTO reserved_hubs (id, account_id, serial, edition, name, public_key, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(rid, id, serial, b.edition, name, publicKey, `support:${c.get("supportActor")}`, ts, ts + days * DAY).run();
    } catch (e) {
      if (/UNIQUE/i.test(String((e as Error)?.message))) return c.json({ error: "serial_taken" }, 409);
      throw e;
    }
    await audit(c, "support.hub.reserve", rid, { accountId: id, edition: b.edition, keyPinned: publicKey !== null });
    return c.json({ reservedHub: { id: rid, serial, edition: b.edition, expiresAt: ts + days * DAY } }, 201);
  });

  app.delete("/api/support/reserved-hubs/:id", async (c) => {
    const r = await c.env.DB.prepare("DELETE FROM reserved_hubs WHERE id = ? AND used_at IS NULL RETURNING account_id").bind(c.req.param("id")).first<{ account_id: string }>();
    if (!r) return c.json({ error: "not_found" }, 404);
    await audit(c, "support.hub.reserve_cancel", c.req.param("id"), { accountId: r.account_id });
    return c.json({ ok: true });
  });

  // ---- BYO license keys (shown once) ----
  app.post("/api/support/accounts/:id/license-keys", async (c) => {
    const id = c.req.param("id"), b = await readObj(c), db = c.env.DB;
    if (!(await accountExists(c, id))) return c.json({ error: "not_found" }, 404);
    const ent = await db.prepare("SELECT plan FROM entitlements WHERE account_id = ?").bind(id).first<{ plan: string }>();
    if (ent?.plan !== "byo") return c.json({ error: "not_byo" }, 409);
    const label = b.label === undefined ? null : text(b.label, 60);
    if (b.label !== undefined && label === null) return c.json({ error: "invalid_label" }, 400);
    const n = await db.prepare("SELECT COUNT(*) AS n FROM license_keys WHERE account_id = ? AND revoked_at IS NULL").bind(id).first<{ n: number }>();
    if ((n?.n ?? 0) >= 10) return c.json({ error: "too_many_keys" }, 409);
    const key = newLicenseKey(), normalized = key.replace(/-/g, ""), kid = crypto.randomUUID();
    await db.prepare("INSERT INTO license_keys (id, account_id, key_hash, hint, label, created_by, created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(kid, id, await licenseKeyHash(c.env.PORTAL_SECRETS, normalized), key.slice(-4), label, `support:${c.get("supportActor")}`, now()).run();
    await audit(c, "support.license_key.create", kid, { accountId: id });
    return c.json({ licenseKey: key, id: kid, hint: key.slice(-4), note: "Shown once. Store it now; only a hash is kept." }, 201);
  });

  app.delete("/api/support/license-keys/:id", async (c) => {
    if (!UUID.test(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
    const r = await c.env.DB.prepare("UPDATE license_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING account_id").bind(now(), c.req.param("id")).first<{ account_id: string }>();
    if (!r) return c.json({ error: "not_found" }, 404);
    await audit(c, "support.license_key.revoke", c.req.param("id"), { accountId: r.account_id });
    return c.json({ ok: true });
  });
}
