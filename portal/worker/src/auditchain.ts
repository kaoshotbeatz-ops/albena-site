import type { Context } from "hono";
import type { AppEnv, Bindings as Env } from "./types";
import { privacyHash } from "./auth/crypto";

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
  meta: string | null; prev_hash: string | null; hash: string | null;
}

const COLS = "id, ts, actor, action, target, request_id, ip_hash, meta, prev_hash, hash";

async function sha(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export const canonical = (r: Row) =>
  JSON.stringify([r.id, r.ts, r.actor, r.action, r.target, r.request_id, r.ip_hash, r.meta]);

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

/** Do not pass tokens, cookies, email addresses or secret values as metadata. */
export async function audit(c: Context<AppEnv>, action: string, target: string, meta?: Record<string, unknown>): Promise<void> {
  const ipHash = await privacyHash(c.env.PORTAL_SECRETS, c.req.header("CF-Connecting-IP") ?? "unknown");
  await c.env.DB.prepare(
    "INSERT INTO audit_log (actor, action, target, request_id, ip_hash, meta) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(c.get("user")?.id ?? "anonymous", action, target, c.get("requestId"), ipHash, meta ? JSON.stringify(meta) : null).run();
  await sealAudit(c.env);
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

