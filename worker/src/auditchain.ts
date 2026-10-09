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

/** Seals all currently unsealed rows. Safe to call concurrently and repeatedly. */
export async function sealAudit(env: Env): Promise<number> {
  let sealed = 0;
  for (;;) {
    const last = await env.DB.prepare(
      "SELECT id, hash FROM audit_log WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1",
    ).first<{ id: number; hash: string }>();
    let prev = last?.hash ?? GENESIS;
    const { results } = await env.DB.prepare(
      `SELECT ${COLS} FROM audit_log WHERE hash IS NULL AND id > ? ORDER BY id ASC LIMIT 200`,
    ).bind(last?.id ?? 0).all<Row>();
    if (!results.length) return sealed;
    const stmts: D1PreparedStatement[] = [];
    for (const r of results) {
      const h = await rowHash(prev, r);
      stmts.push(
        env.DB.prepare("UPDATE audit_log SET prev_hash = ?, hash = ? WHERE id = ? AND hash IS NULL").bind(prev, h, r.id),
      );
      prev = h;
    }
    await env.DB.batch(stmts);
    sealed += results.length;
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
