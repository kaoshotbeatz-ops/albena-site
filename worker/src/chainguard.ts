import type { Env } from "./types";
import { audit, verifyChain, type ChainStatus } from "./auditchain";

/**
 * ALB-SEC-1 daily audit-chain verifier + R3 hold (white paper, "Audit log": a break raises an
 * alert and blocks R3 actions until acknowledged).
 *
 * runChainCheck walks the whole chain, records the result in chain_state and in the chain itself
 * (audit.chain.verified / audit.chain.broken) and, on a break, raises a critical event in Obvera
 * Event Management. While a break is unacknowledged, every route in R3_ROUTES answers 423.
 * The owner acknowledges a specific break (its signature); that writes audit.chain.ack. A new,
 * different break blocks again. Acknowledging never edits history; fixing a fork is repairChain.
 */
export const SOURCE = "albena-site";

/** High-risk (R3) routes on this worker: bulk export of personal data. */
export const R3_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ["GET", /^\/api\/admin\/export\//],
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
  // Missing row = migration not applied: fail closed for R3 (treated as an unacknowledged break).
  return r ?? ({ status: "broken", broken_sig: "state_missing@0", broken_reason: "state_missing" } as ChainState);
}

export const isHeld = (s: ChainState) => s.status === "broken" && s.acked_sig !== s.broken_sig;

export function isR3(method: string, path: string): boolean {
  return R3_ROUTES.some(([m, re]) => m === method && re.test(path));
}

/** Posts one event to Obvera Event Management. Never throws; returns a short outcome for chain_state. */
export async function sendAlert(env: Env, ev: { severity: "critical" | "warning" | "info"; message: string; status?: "resolved" }): Promise<string> {
  if (!env.OBVERA_EVENTS_URL || !env.OBVERA_EVENTS_KEY) return "skipped:not_configured";
  try {
    const res = await fetch(env.OBVERA_EVENTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OBVERA_EVENTS_KEY}` },
      body: JSON.stringify({
        source: SOURCE, node: SOURCE, type: "audit.chain_break", ci: SOURCE,
        dedupe_key: `${SOURCE}:audit.chain_break`, severity: ev.severity, message: ev.message.slice(0, 500),
        resource_url: "https://albena.ai/admin/system", ...(ev.status ? { status: ev.status } : {}),
      }),
    });
    return res.ok ? "sent" : `failed:${res.status}`;
  } catch {
    return "failed:network";
  }
}

const sys = (env: Env, action: string, target: string) => audit(env, { actor: "system", action, target, requestId: crypto.randomUUID() });

/** The verifier job. Safe to run any time; the cron runs it daily. */
export async function runChainCheck(env: Env, trigger: string, now = new Date()): Promise<{ chain: ChainStatus; state: ChainState; alert: string | null }> {
  const ts = now.toISOString();
  const before = await getState(env);
  const chain = await verifyChain(env);
  let alert: string | null = null;
  if (!chain.ok) {
    const sig = sigOf(chain);
    const fresh = before.broken_sig !== sig || before.status !== "broken";
    await env.DB.prepare(
      "UPDATE chain_state SET status = 'broken', broken_sig = ?1, broken_reason = ?2, broken_at_id = ?3, detected_at = CASE WHEN broken_sig = ?1 AND status = 'broken' THEN detected_at ELSE ?4 END, last_run_at = ?4, last_rows = ?5 WHERE id = 1",
    ).bind(sig, chain.reason ?? null, chain.brokenAtId ?? null, ts, chain.rows).run();
    await sys(env, "audit.chain.broken", `${sig}; rows ${chain.rows}; trigger ${trigger}`);
    const acked = before.acked_sig === sig;
    alert = await sendAlert(env, {
      severity: acked ? "warning" : "critical",
      message: `albena.ai audit chain BROKEN (${sig}, ${chain.rows} rows). ${acked ? "Acknowledged by owner; still unrepaired." : "High-risk admin actions are blocked until the owner acknowledges in /admin/system."}${fresh ? "" : " (still broken)"}`,
    });
  } else {
    await env.DB.prepare(
      "UPDATE chain_state SET status = 'ok', last_run_at = ?1, last_ok_at = ?1, last_head = ?2, last_rows = ?3 WHERE id = 1",
    ).bind(ts, chain.headHash, chain.rows).run();
    await sys(env, "audit.chain.verified", `ok; rows ${chain.rows}; head ${chain.headHash?.slice(0, 16) ?? "none"}; trigger ${trigger}`);
    if (before.status === "broken") alert = await sendAlert(env, { severity: "info", status: "resolved", message: `albena.ai audit chain intact again (${chain.rows} rows).` });
  }
  if (alert) await env.DB.prepare("UPDATE chain_state SET last_alert = ? WHERE id = 1").bind(`${ts} ${alert}`).run();
  if (alert && alert !== "sent") console.error("chain alert not delivered", alert);
  return { chain, state: await getState(env), alert };
}

/** Owner acknowledgement of the current break. Returns an error code or the new state. */
export async function acknowledge(env: Env, a: { actor: string; sig: string; note: string; requestId: string; ipHash?: string }): Promise<{ error: string } | { state: ChainState }> {
  const s = await getState(env);
  if (s.status !== "broken" || !s.broken_sig) return { error: "nothing_to_acknowledge" };
  if (a.sig !== s.broken_sig) return { error: "signature_mismatch" };
  if (s.acked_sig === s.broken_sig) return { error: "already_acknowledged" };
  await audit(env, { actor: a.actor, action: "audit.chain.ack", target: `${s.broken_sig}; note: ${a.note}`.slice(0, 500), requestId: a.requestId, ipHash: a.ipHash });
  await env.DB.prepare("UPDATE chain_state SET acked_sig = ?, acked_by = ?, acked_at = ?, ack_note = ? WHERE id = 1 AND broken_sig = ?")
    .bind(s.broken_sig, a.actor, new Date().toISOString(), a.note.slice(0, 500), s.broken_sig).run();
  return { state: await getState(env) };
}
