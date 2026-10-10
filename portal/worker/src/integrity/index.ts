import type { Context, Hono } from "hono";
import type { AppEnv, Bindings as Env } from "../types";
import { audit, auditSystem, verifyChain, type ChainStatus } from "../auditchain";
import { requireSupportAdmin } from "../support/access";

/**
 * ALB-SEC-1 daily audit-chain verifier + R3 hold for the portal (white paper, "Audit log": a break
 * raises an alert and blocks R3 actions until acknowledged).
 *
 * runChainCheck walks the whole chain, records the result in chain_state and in the chain itself
 * (audit.chain.verified / audit.chain.broken) and, on a break, raises a critical event in Obvera Event
 * Management. While a break is unacknowledged, every route in R3_ROUTES answers 423. The platform owner
 * (Access + SUPPORT_ADMIN_EMAILS) acknowledges a specific break by signature; that writes audit.chain.ack.
 * A different break blocks again. Acknowledging never edits audit history.
 *
 * Mounted FIRST so the hold runs before every other module's handlers.
 */
export const migrations = ["1000_chain_state.sql"];
export const SOURCE = "albena-portal";

/** R3 on the portal: spend money, delete data/accounts/hubs, change licensing, impersonation. */
export const R3_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ["POST", /^\/api\/account\/delete$/],
  ["DELETE", /^\/api\/hubs\/[^/]+$/],
  ["DELETE", /^\/api\/account\/members\/[^/]+$/],
  ["DELETE", /^\/api\/security\/passkeys\/[^/]+$/],
  ["POST", /^\/api\/billing\/checkout$/],
  ["POST", /^\/api\/billing\/portal$/],
  ["POST", /^\/api\/support\/view-as\/start$/],
  ["POST", /^\/api\/support\/accounts\/[^/]+\/entitlement$/],
  ["POST", /^\/api\/support\/accounts\/[^/]+\/license-keys$/],
  ["DELETE", /^\/api\/support\/license-keys\/[^/]+$/],
  ["PATCH", /^\/api\/support\/orders\/[^/]+$/],
];

export interface ChainState {
  status: "ok" | "broken" | "unknown";
  broken_sig: string | null; broken_reason: string | null; broken_at_id: number | null; detected_at: string | null;
  acked_sig: string | null; acked_by: string | null; acked_at: string | null; ack_note: string | null;
  last_run_at: string | null; last_ok_at: string | null; last_head: string | null; last_rows: number | null; last_alert: string | null;
}

export const sigOf = (s: ChainStatus) => `${s.reason ?? "unknown"}@${s.brokenAtId ?? 0}`;

export async function getState(env: Env): Promise<ChainState> {
  const r = await env.DB.prepare("SELECT * FROM chain_state WHERE id = 1").first<ChainState>();
  // Missing row = migration not applied: fail closed for R3.
  return r ?? ({ status: "broken", broken_sig: "state_missing@0", broken_reason: "state_missing" } as ChainState);
}
export const isHeld = (s: ChainState) => s.status === "broken" && s.acked_sig !== s.broken_sig;
export const isR3 = (method: string, path: string) => R3_ROUTES.some(([m, re]) => m === method && re.test(path));

export async function sendAlert(env: Env, ev: { severity: "critical" | "warning" | "info"; message: string; status?: "resolved" }): Promise<string> {
  if (!env.OBVERA_EVENTS_URL || !env.OBVERA_EVENTS_KEY) return "skipped:not_configured";
  try {
    const res = await fetch(env.OBVERA_EVENTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OBVERA_EVENTS_KEY}` },
      body: JSON.stringify({
        source: SOURCE, node: SOURCE, type: "audit.chain_break", ci: SOURCE,
        dedupe_key: `${SOURCE}:audit.chain_break`, severity: ev.severity, message: ev.message.slice(0, 500),
        resource_url: "https://account.albena.ai/support", ...(ev.status ? { status: ev.status } : {}),
      }),
    });
    return res.ok ? "sent" : `failed:${res.status}`;
  } catch {
    return "failed:network";
  }
}

/** The verifier job (daily from cron; also on demand). */
export async function runChainCheck(env: Env, trigger: string, now = new Date()): Promise<{ chain: ChainStatus; state: ChainState; alert: string | null }> {
  const ts = now.toISOString();
  const before = await getState(env);
  const chain = await verifyChain(env);
  let alert: string | null = null;
  if (!chain.ok) {
    const sig = sigOf(chain);
    await env.DB.prepare(
      "UPDATE chain_state SET status = 'broken', broken_sig = ?1, broken_reason = ?2, broken_at_id = ?3, detected_at = CASE WHEN broken_sig = ?1 AND status = 'broken' THEN detected_at ELSE ?4 END, last_run_at = ?4, last_rows = ?5 WHERE id = 1",
    ).bind(sig, chain.reason ?? null, chain.brokenAtId ?? null, ts, chain.rows).run();
    await auditSystem(env, "system:cron", "audit.chain.broken", sig, { rows: chain.rows, trigger });
    const acked = before.acked_sig === sig;
    alert = await sendAlert(env, {
      severity: acked ? "warning" : "critical",
      message: `account.albena.ai audit chain BROKEN (${sig}, ${chain.rows} rows). ${acked ? "Acknowledged by owner; still unrepaired." : "High-risk portal actions are blocked until the owner acknowledges."}`,
    });
  } else {
    await env.DB.prepare("UPDATE chain_state SET status = 'ok', last_run_at = ?1, last_ok_at = ?1, last_head = ?2, last_rows = ?3 WHERE id = 1")
      .bind(ts, chain.headHash, chain.rows).run();
    await auditSystem(env, "system:cron", "audit.chain.verified", "ok", { rows: chain.rows, head: chain.headHash?.slice(0, 16) ?? null, trigger });
    if (before.status === "broken") alert = await sendAlert(env, { severity: "info", status: "resolved", message: `account.albena.ai audit chain intact again (${chain.rows} rows).` });
  }
  if (alert) await env.DB.prepare("UPDATE chain_state SET last_alert = ? WHERE id = 1").bind(`${ts} ${alert}`).run();
  if (alert && alert !== "sent") console.error("chain alert not delivered", alert);
  return { chain, state: await getState(env), alert };
}

/** Daily: at 04:xx UTC, or whenever the last run is older than 26 h (missed cron). */
export async function maybeRunDaily(env: Env, now = new Date()): Promise<boolean> {
  const s = await getState(env);
  const stale = !s.last_run_at || now.getTime() - Date.parse(s.last_run_at) > 26 * 3600_000;
  if (now.getUTCHours() !== 4 && !stale) return false;
  if (!stale && s.last_run_at && now.getTime() - Date.parse(s.last_run_at) < 3600_000) return false;
  await runChainCheck(env, "cron", now);
  return true;
}

async function hold(c: Context<AppEnv>, next: () => Promise<void>) {
  if (isR3(c.req.method, c.req.path) && isHeld(await getState(c.env))) {
    // No audit row here: this runs before authentication, so writing would let anonymous callers grow the log.
    console.warn("integrity hold refused", c.req.method, c.req.path);
    return c.json({ error: "integrity_hold", detail: "Audit verification failed. High-risk actions are paused until the owner acknowledges.", requestId: c.get("requestId") }, 423);
  }
  await next();
}

export function mount(app: Hono<AppEnv>): void {
  app.use("/api/*", hold);

  app.get("/api/support/integrity", requireSupportAdmin, async (c) => c.json({ chain: await verifyChain(c.env), integrity: await getState(c.env) }));

  app.post("/api/support/integrity/verify", requireSupportAdmin, async (c) => {
    const r = await runChainCheck(c.env, `manual:${c.get("supportActor")}`);
    return c.json({ ok: r.chain.ok, chain: r.chain, integrity: r.state, alert: r.alert });
  });

  app.post("/api/support/integrity/ack", requireSupportAdmin, async (c) => {
    const b = await c.req.json<{ sig?: unknown; note?: unknown }>().catch(() => ({} as { sig?: unknown; note?: unknown }));
    const sig = typeof b.sig === "string" ? b.sig : "", note = typeof b.note === "string" ? b.note.trim() : "";
    if (sig.length < 3 || sig.length > 200 || note.length < 5 || note.length > 400) return c.json({ error: "validation_failed" }, 400);
    const s = await getState(c.env);
    if (s.status !== "broken" || !s.broken_sig) return c.json({ error: "nothing_to_acknowledge" }, 409);
    if (sig !== s.broken_sig) return c.json({ error: "signature_mismatch" }, 409);
    if (s.acked_sig === s.broken_sig) return c.json({ error: "already_acknowledged" }, 409);
    await audit(c, "audit.chain.ack", s.broken_sig, { note });
    await c.env.DB.prepare("UPDATE chain_state SET acked_sig = ?, acked_by = ?, acked_at = ?, ack_note = ? WHERE id = 1 AND broken_sig = ?")
      .bind(s.broken_sig, c.get("supportActor") ?? "unknown", new Date().toISOString(), note, s.broken_sig).run();
    return c.json({ ok: true, integrity: await getState(c.env) });
  });
}
