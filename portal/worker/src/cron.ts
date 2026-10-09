import type { Bindings } from "./types";
import { sealAudit } from "./auditchain";
import { IDLE_SECONDS } from "./auth/sessions";

/** Hub rate windows are at most 10 minutes; keep a margin before deleting the counter. */
const RATE_RETAIN_S = 3600;
/** Used pair codes are kept briefly so a replay is answered like any other bad code. */
const USED_CODE_RETAIN_S = 24 * 3600;

/** Deletes expired short-lived rows. Returns per-table counts for tests; never logs row content. */
export async function prune(env: Bindings, ts = Math.floor(Date.now() / 1000)): Promise<Record<string, number>> {
  const run = async (name: string, sql: string, ...args: number[]) =>
    [name, (await env.DB.prepare(sql).bind(...args).run()).meta.changes ?? 0] as const;
  const out = await Promise.all([
    run("magicTokens", "DELETE FROM magic_tokens WHERE expires_at <= ?", ts),
    run("authChallenges", "DELETE FROM auth_challenges WHERE expires_at <= ?", ts),
    run("sessions", "DELETE FROM sessions WHERE expires_at <= ? OR last_seen <= ?", ts, ts - IDLE_SECONDS),
    run("hubPairCodes", "DELETE FROM hub_pair_codes WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)", ts - USED_CODE_RETAIN_S, ts - USED_CODE_RETAIN_S),
    run("hubNonces", "DELETE FROM hub_nonces WHERE expires_at <= ?", ts),
    run("hubRate", "DELETE FROM hub_rate WHERE window_start <= ?", ts - RATE_RETAIN_S),
  ]);
  return Object.fromEntries(out);
}

export async function scheduled(_event: ScheduledController, env: Bindings): Promise<void> {
  await prune(env);
  await sealAudit(env); // seal any rows left unsealed by a request that died mid-audit
}
