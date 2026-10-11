import type { Context, Hono, MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";
import { audit, requireUser } from "../auth";
import { SIG16, type SecurityStat } from "../hubs/schema";
import { isOnline, parseStored } from "../hubs/stats";

/**
 * Portal security page for Hubs. "The model is untrusted; the gate is code": the portal never approves anything on the
 * AI's behalf. The owner can only (1) acknowledge a specific audit-chain break and (2) revoke earned trust, and only with a
 * passkey session. Both are queued here and delivered in the next signed heartbeat reply (`security` key); the Hub applies them.
 */
export const migrations = ["1100_hub_security.sql"];

const now = () => Math.floor(Date.now() / 1000);
type C = Context<AppEnv>;
const NOTE_MAX = 200;

export const RISK_TIERS = [
  { id: "R0", name: "Read-only", summary: "Just answers. Albena looks things up and tells you; nothing changes." },
  { id: "R1", name: "Home comfort", summary: "Lights, TV and scenes. Albena may earn trust for a repeat action after 5 approved repeats." },
  { id: "R2", name: "Messages, memory and delegation", summary: "Always asks you first." },
  { id: "R3", name: "Code, infrastructure, identity, money and deletion", summary: "Asks you, and you enter your PIN on the Hub. Destructive actions need a long press." },
  { id: "R4", name: "Never allowed", summary: "Security decisions: approving, granting trust, PIN entry, chain acknowledgement and AgentGate mode. Only a person on the Hub screen or this page can do these." },
] as const;

/** Writes need a session established with a passkey (sessions.login_method). Magic-link, older and view-as sessions are refused. */
export const requirePasskeySession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("loginMethod") !== "passkey" || c.get("viewAs")) return c.json({ error: "passkey_required" }, 403);
  await next();
};

/** The Hub, only when it belongs to the caller's account. */
async function ownHub(c: C) {
  return c.env.DB.prepare("SELECT id, last_seen, stats_json FROM hubs WHERE id = ? AND account_id = ?")
    .bind(c.req.param("id"), c.get("user").accountId).first<{ id: string; last_seen: number | null; stats_json: string | null }>();
}
const securityOf = (stats_json: string | null): SecurityStat | null => parseStored(stats_json)?.security ?? null;

/**
 * Called by the heartbeat after the snapshot is stored. Atomically claims queued commands (UPDATE ... RETURNING, so each is
 * delivered once). A chain_ack is delivered only when this heartbeat carries a security block whose break_sig still equals the
 * acknowledged one; otherwise it is dropped. Without a security block it stays queued. Delivery is at-most-once: if the reply is lost the owner can ask again.
 */
export async function claimCommands(db: D1Database, hubId: string, security: SecurityStat | undefined, t = now()): Promise<{ chainAck: { sig: string } | null; revokeTrust: boolean }> {
  const revoked = await db.prepare("UPDATE hub_security_commands SET delivered_at = ?1 WHERE hub_id = ?2 AND kind = 'revoke_trust' AND delivered_at IS NULL RETURNING id").bind(t, hubId).all();
  let chainAck: { sig: string } | null = null;
  if (security) {
    const live = security.chain === "broken" && security.break_sig && security.acked_sig !== security.break_sig ? security.break_sig : null;
    const acks = await db.prepare(
      "UPDATE hub_security_commands SET delivered_at = ?1, dropped = CASE WHEN sig = ?3 THEN 0 ELSE 1 END WHERE hub_id = ?2 AND kind = 'chain_ack' AND delivered_at IS NULL RETURNING sig, dropped",
    ).bind(t, hubId, live).all<{ sig: string; dropped: number }>();
    const kept = acks.results.find((a) => a.dropped === 0);
    if (kept) chainAck = { sig: kept.sig };
  }
  return { chainAck, revokeTrust: revoked.results.length > 0 };
}

export function mount(app: Hono<AppEnv>): void {
  app.get("/api/security/overview", requireUser, async (c) => {
    const { results } = await c.env.DB.prepare("SELECT id, name, last_seen, stats_json FROM hubs WHERE account_id = ? ORDER BY created_at")
      .bind(c.get("user").accountId).all<{ id: string; name: string; last_seen: number | null; stats_json: string | null }>();
    const hubs = [];
    for (const h of results) {
      const pending = await c.env.DB.prepare("SELECT kind, requested_at AS requestedAt FROM hub_security_commands WHERE hub_id = ? AND delivered_at IS NULL ORDER BY id")
        .bind(h.id).all<{ kind: string; requestedAt: number }>();
      hubs.push({ id: h.id, name: h.name, online: isOnline(h.last_seen), security: securityOf(h.stats_json), pending: pending.results });
    }
    return c.json({ hubs, tiers: RISK_TIERS });
  });

  /** Writes: signed in (requireUser), owner only, then a passkey session. */
  const ownerOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.get("user").role !== "owner") return c.json({ error: "forbidden" }, 403);
    await next();
  };

  app.post("/api/hubs/:id/security/chain-ack", requireUser, ownerOnly, requirePasskeySession, async (c) => {
    const hub = await ownHub(c);
    if (!hub) return c.json({ error: "not_found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "bad_request" }, 400); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return c.json({ error: "bad_request" }, 400);
    const { sig, note, ...extra } = body as Record<string, unknown>;
    if (Object.keys(extra).length || typeof sig !== "string" || !SIG16.test(sig)) return c.json({ error: "bad_request" }, 400);
    if (note !== undefined && (typeof note !== "string" || note.length > NOTE_MAX || /[\u0000-\u001f\u007f<>]/.test(note))) return c.json({ error: "bad_note" }, 400);
    const sec = securityOf(hub.stats_json);
    if (!sec || sec.chain !== "broken" || !sec.break_sig) return c.json({ error: "no_break" }, 409);
    if (sig !== sec.break_sig) return c.json({ error: "sig_mismatch" }, 409);
    if (sec.acked_sig === sig) return c.json({ error: "already_acked" }, 409);
    const t = now();
    // One queued acknowledgement per break: a repeat click while it is still pending is a no-op.
    await c.env.DB.prepare(
      `INSERT INTO hub_security_commands (hub_id, kind, sig, requested_by, requested_at, note)
       SELECT ?1, 'chain_ack', ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM hub_security_commands WHERE hub_id = ?1 AND kind = 'chain_ack' AND sig = ?2 AND delivered_at IS NULL)`,
    ).bind(hub.id, sig, c.get("user").id, t, note?.trim() || null).run();
    await audit(c, "security.chain.ack", hub.id, { sig, noteLength: note?.trim().length ?? 0 });
    return c.json({ ok: true }, 202);
  });

  app.post("/api/hubs/:id/security/revoke-trust", requireUser, ownerOnly, requirePasskeySession, async (c) => {
    const hub = await ownHub(c);
    if (!hub) return c.json({ error: "not_found" }, 404);
    await c.env.DB.prepare(
      `INSERT INTO hub_security_commands (hub_id, kind, requested_by, requested_at)
       SELECT ?1, 'revoke_trust', ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM hub_security_commands WHERE hub_id = ?1 AND kind = 'revoke_trust' AND delivered_at IS NULL)`,
    ).bind(hub.id, c.get("user").id, now()).run();
    await audit(c, "security.trust.revoke", hub.id);
    return c.json({ ok: true }, 202);
  });
}
