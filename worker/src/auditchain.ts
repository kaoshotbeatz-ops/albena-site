import type { Env } from "./types";

/**
 * AU-9 / AU-10 tamper-evident audit log.
 *
 * D1 has no SHA-256 SQL function, so rows are inserted (inside the caller's
 * atomic batch, exactly as before) with hash = NULL and then "sealed" in JS:
 *   hash = SHA-256(prev_hash || JSON([id, ts, actor, action, target, request_id, ip_hash]))
 *
 * Race handling: D1 serializes writes per database and AUTOINCREMENT ids grow in
 * commit order, so a row with a lower id can never commit after a higher one is
 * visible. Sealing always processes unsealed rows with id > max(sealed id), in id
 * order, starting from the latest sealed hash, so every sealer computes identical
 * values for identical rows. Two concurrent sealers therefore write the same bytes;
 * `WHERE hash IS NULL` makes the second write a no-op. Rows are never re-sealed.
 * A NULL hash followed by a sealed row (a "hole") is reported by verifyChain.
 */
export const GENESIS = "0".repeat(64);

interface Row {
  id: number; ts: string; actor: string; action: string;
  target: string | null; request_id: string; ip_hash: string | null;
  prev_hash: string | null; hash: string | null;
}

const COLS = "id, ts, actor, action, target, request_id, ip_hash, prev_hash, hash";

async function sha(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export const canonical = (r: Row) =>
  JSON.stringify([r.id, r.ts, r.actor, r.action, r.target, r.request_id, r.ip_hash]);

export const rowHash = (prev: string, r: Row) => sha(prev + canonical(r));

/**
 * Chain-safe seal: applies only if the immediately preceding row (max id < this id) carries
 * exactly the prev hash we used (or there is no preceding row and prev is GENESIS). A sealer
 * working from a stale view therefore changes 0 rows instead of forking the chain.
 */
const SEAL_SQL =
  "UPDATE audit_log SET prev_hash = ?1, hash = ?2 WHERE id = ?3 AND hash IS NULL AND (" +
  "(SELECT hash FROM audit_log WHERE id < ?3 ORDER BY id DESC LIMIT 1) = ?1 OR " +
  "(NOT EXISTS (SELECT 1 FROM audit_log WHERE id < ?3) AND ?1 = ?4))";

const MAX_STALE_RETRIES = 5;

/** Seals all currently unsealed rows. Safe to call concurrently and repeatedly. */
export async function sealAudit(env: Env): Promise<number> {
  // Read from the primary so a lagging read replica can never hand us a stale chain head.
  const db = typeof env.DB.withSession === "function" ? env.DB.withSession("first-primary") : env.DB;
  let sealed = 0, stale = 0;
  for (;;) {
    const last = await db.prepare(
      "SELECT id, hash FROM audit_log WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1",
    ).first<{ id: number; hash: string }>();
    let prev = last?.hash ?? GENESIS;
    const { results } = await db.prepare(
      `SELECT ${COLS} FROM audit_log WHERE hash IS NULL AND id > ? ORDER BY id ASC LIMIT 200`,
    ).bind(last?.id ?? 0).all<Row>();
    if (!results.length) return sealed;
    const stmts: D1PreparedStatement[] = [];
    for (const r of results) {
      const h = await rowHash(prev, r);
      stmts.push(db.prepare(SEAL_SQL).bind(prev, h, r.id, GENESIS));
      prev = h;
    }
    const res = await db.batch(stmts);
    const n = res.reduce((a, x) => a + (x.meta.changes ?? 0), 0);
    sealed += n;
    if (n < results.length) {
      // Another sealer won (or our view was stale): re-read and retry, bounded.
      if (++stale > MAX_STALE_RETRIES) return sealed;
    } else stale = 0;
  }
}

export async function audit(
  env: Env,
  e: { actor: string; action: string; target?: string; requestId: string; ipHash?: string },
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_log (actor, action, target, request_id, ip_hash) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(e.actor, e.action, e.target ?? null, e.requestId, e.ipHash ?? null)
    .run();
  await sealAudit(env);
}

export interface ChainStatus {
  ok: boolean;
  rows: number;
  sealed: number;
  unsealed: number;
  headHash: string | null;
  brokenAtId?: number;
  reason?: string;
}

/** Re-computes the whole chain. Unsealed rows are only acceptable at the tail. */
export async function verifyChain(env: Env): Promise<ChainStatus> {
  let prev = GENESIS;
  let after = 0, rows = 0, sealed = 0, unsealed = 0;
  const fail = (r: Row, reason: string): ChainStatus => ({
    ok: false, rows, sealed, unsealed, headHash: prev === GENESIS ? null : prev, brokenAtId: r.id, reason,
  });
  for (;;) {
    const { results } = await env.DB.prepare(
      `SELECT ${COLS} FROM audit_log WHERE id > ? ORDER BY id ASC LIMIT 1000`,
    ).bind(after).all<Row>();
    if (!results.length) break;
    for (const r of results) {
      after = r.id;
      rows++;
      if (r.hash === null) { unsealed++; continue; }
      if (unsealed > 0) return fail(r, "sealed_row_after_unsealed");
      if (r.prev_hash !== prev) return fail(r, "prev_hash_mismatch");
      if ((await rowHash(prev, r)) !== r.hash) return fail(r, "hash_mismatch");
      prev = r.hash;
      sealed++;
    }
  }
  return { ok: true, rows, sealed, unsealed, headHash: prev === GENESIS ? null : prev };
}

export interface RepairResult { repairedFrom: number; repairedTo: number; repairRowId: number; oldHead: string | null; forkHead: string | null }

/**
 * One-shot repair of a concurrent-sealer fork (verifyChain: prev_hash_mismatch). Refuses anything
 * else: every row from the break onward must be self-consistent (hash matches its own stored prev_hash),
 * so only a pure linkage fork is repaired, never edited content. The old hashes are preserved in
 * audit_chain_repairs and an `audit.chain.repair` row is inserted (unsealed) BEFORE the re-seal, so
 * the repair is itself part of the re-sealed chain. Re-seal runs in one atomic D1 batch.
 */
export async function repairChain(env: Env, actor: string, requestId: string): Promise<RepairResult | { error: string }> {
  const status = await verifyChain(env);
  if (status.ok) return { error: "chain_ok" };
  if (status.reason !== "prev_hash_mismatch" || !status.brokenAtId) return { error: `not_repairable:${status.reason}` };
  const from = status.brokenAtId;
  const { results: rows } = await env.DB.prepare(`SELECT ${COLS} FROM audit_log WHERE id >= ? ORDER BY id ASC LIMIT 5001`).bind(from).all<Row>();
  if (rows.length > 5000) return { error: "too_many_rows" };
  for (const r of rows) {
    if (r.hash !== null && (r.prev_hash === null || (await rowHash(r.prev_hash, r)) !== r.hash)) return { error: `not_repairable:hash_mismatch@${r.id}` };
  }
  const before = await env.DB.prepare("SELECT hash FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT 1").bind(from).first<{ hash: string | null }>();
  const startPrev = before?.hash ?? GENESIS;
  const to = rows[rows.length - 1].id;
  const oldHashes: Record<number, string | null> = {};
  for (const r of rows) oldHashes[r.id] = r.hash;
  const forkHead = [...rows].reverse().find((r) => r.hash)?.hash ?? null;
  const oldHead = before?.hash ?? null;
  const target = `re-sealed ids ${from}..${to} after concurrent-sealer fork; old head ${oldHead?.slice(0, 6) ?? "none"}…/fork head ${forkHead?.slice(0, 6) ?? "none"}…`;
  // Raw insert (not audit()) so nothing seals before the old hashes are saved.
  await env.DB.batch([
    env.DB.prepare("INSERT INTO audit_log (actor, action, target, request_id) VALUES (?, 'audit.chain.repair', ?, ?)").bind(actor, target, requestId),
    env.DB.prepare(
      "INSERT INTO audit_chain_repairs (from_id, to_id, actor, request_id, old_head, fork_head, old_hashes, repair_row_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT MAX(id) FROM audit_log))",
    ).bind(from, to, actor, requestId, oldHead, forkHead, JSON.stringify(oldHashes)),
  ]);
  const repairRowId = (await env.DB.prepare("SELECT id FROM audit_log WHERE action = 'audit.chain.repair' AND request_id = ?").bind(requestId).first<{ id: number }>())!.id;
  const { results: all } = await env.DB.prepare(`SELECT ${COLS} FROM audit_log WHERE id >= ? ORDER BY id ASC`).bind(from).all<Row>();
  let prev = startPrev;
  const stmts: D1PreparedStatement[] = [];
  for (const r of all) {
    const h = await rowHash(prev, r);
    stmts.push(env.DB.prepare("UPDATE audit_log SET prev_hash = ?, hash = ? WHERE id = ?").bind(prev, h, r.id));
    prev = h;
  }
  await env.DB.batch(stmts);
  return { repairedFrom: from, repairedTo: to, repairRowId, oldHead, forkHead };
}
