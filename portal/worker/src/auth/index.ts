import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { audit } from "../auditchain";
import { mountMagic } from "./magic";
import { mountPasskeys } from "./passkeys";
import { requireUser, clearSession, now, IDLE_SECONDS } from "./sessions";
export { requireUser } from "./sessions";
export { audit } from "../auditchain";
export type { AppEnv } from "../types";
export const migrations = ["0100_auth_core.sql"];

export function mount(app: Hono<AppEnv>): void {
  mountMagic(app);
  mountPasskeys(app);
  app.get("/api/me", requireUser, c => c.json({ user: c.get("user") }));
  app.post("/api/auth/logout", requireUser, async c => {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(c.get("sessionId")).run();
    clearSession(c);
    await audit(c, "auth.logout", c.get("user").id);
    return c.json({ ok: true });
  });
  app.get("/api/security/sessions", requireUser, async c => {
    const ts = now();
    const { results } = await c.env.DB.prepare("SELECT id, created_at AS createdAt, last_seen AS lastSeen, expires_at AS expiresAt FROM sessions WHERE user_id = ? AND last_seen > ? AND expires_at > ? ORDER BY created_at DESC")
      .bind(c.get("user").id, ts - IDLE_SECONDS, ts).all<{ id: string }>();
    return c.json({ sessions: results.map(s => ({ ...s, current: s.id === c.get("sessionId") })) });
  });
  app.delete("/api/security/sessions/:id", requireUser, async c => {
    const id = c.req.param("id");
    const deleted = await c.env.DB.prepare("DELETE FROM sessions WHERE id = ? AND user_id = ? RETURNING id")
      .bind(id, c.get("user").id).first();
    if (!deleted) return c.json({ error: "not_found" }, 404);
    if (id === c.get("sessionId")) clearSession(c);
    await audit(c, "auth.session.revoke", id);
    return c.json({ ok: true });
  });
}
