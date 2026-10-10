import type { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../types";
import { audit } from "../auditchain";
import { randomToken, sha256 } from "../auth/crypto";
import { VIEWAS_COOKIE, VIEWAS_SECONDS, viewAsCookieOptions, now } from "../auth/sessions";
import { requireSupportAdmin } from "./access";
import { mountInvites } from "./invites";
import { mountOps } from "./ops";
import { mountHubs } from "./hubs";

export const migrations = ["0400_viewas.sql", "0500_customer_ops.sql"];
const EXIT_URL = "https://albena.ai/admin";

/**
 * Staff console + view-as. Everything here except /api/support/view-as/end is gated by a verified Cloudflare Access JWT
 * and the SUPPORT_ADMIN_EMAILS allowlist. The customer-facing /support page (exactly /support) stays public.
 */
export function mount(app: Hono<AppEnv>): void {
  app.use("/support/*", async (c, next) => (/^\/support\/?$/.test(c.req.path) ? next() : requireSupportAdmin(c, next)));
  app.use("/api/support/*", async (c, next) => (c.req.path === "/api/support/view-as/end" ? next() : requireSupportAdmin(c, next)));

  app.get("/support/view-as", async (c) => {
    const id = c.req.query("account") ?? "";
    const acct = await c.env.DB.prepare("SELECT a.id, a.owner FROM accounts a WHERE a.id = ?").bind(id).first<{ id: string; owner: string }>();
    if (!acct) return c.json({ error: "not_found" }, 404);
    const token = randomToken(), ts = now(), actor = c.get("supportActor")!;
    const old = getCookie(c, VIEWAS_COOKIE);
    const stmts = [];
    if (old) stmts.push(c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ? AND view_as = 1").bind(await sha256(old)));
    stmts.push(c.env.DB.prepare("INSERT INTO sessions (id, token_hash, user_id, account_id, created_at, last_seen, expires_at, view_as, readonly, actor) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)")
      .bind(crypto.randomUUID(), await sha256(token), acct.owner, acct.id, ts, ts, ts + VIEWAS_SECONDS, actor));
    await c.env.DB.batch(stmts);
    await audit(c, "support.view_as.start", acct.id);
    setCookie(c, VIEWAS_COOKIE, token, { ...viewAsCookieOptions, maxAge: VIEWAS_SECONDS });
    return c.redirect("/", 302);
  });

  app.get("/api/support/accounts", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT a.id, u.email, COALESCE(e.plan, 'none') AS plan, COALESCE(e.status, 'none') AS status, COALESCE(e.source, 'stripe') AS source, e.ends_at AS endsAt, COALESCE(e.comp, 0) AS comp,
        (SELECT COUNT(*) FROM hubs h WHERE h.account_id = a.id) AS hubs, a.created_at AS created
       FROM accounts a JOIN users u ON u.id = a.owner LEFT JOIN entitlements e ON e.account_id = a.id
       ORDER BY a.created_at DESC LIMIT 500`,
    ).all();
    return c.json({ accounts: results, me: c.get("supportActor") });
  });

  // One static page serves every customer: /support/customers/<id> (the page script reads the id from the path). Access-gated above.
  app.get("/support/customers/:id", (c) => c.env.ASSETS.fetch(new Request(new URL("/support/customer", c.req.url), { headers: c.req.raw.headers })));

  mountOps(app);
  mountHubs(app);
  mountInvites(app);

  // Authenticated by the view-as cookie itself (the customer UI is not behind Access). Allowed in read-only mode.
  app.post("/api/support/view-as/end", async (c) => {
    const token = getCookie(c, VIEWAS_COOKIE);
    if (token) {
      const row = await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ? AND view_as = 1 RETURNING account_id, actor")
        .bind(await sha256(token)).first<{ account_id: string; actor: string }>();
      if (row) { c.set("supportActor", row.actor); await audit(c, "support.view_as.end", row.account_id); }
    }
    deleteCookie(c, VIEWAS_COOKIE, viewAsCookieOptions);
    return c.json({ ok: true, redirect: EXIT_URL });
  });
}
