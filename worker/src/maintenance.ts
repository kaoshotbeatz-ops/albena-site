import type { Env } from "./types";
import { audit, verifyChain } from "./auditchain";
import { sha256Hex } from "./util";

export const KEEP_BACKUPS = 35;
export const RETENTION_DAYS = 365;
const TABLES = ["waitlist", "tickets", "audit_log"] as const;
const PAGE = 1000;

const prefix = (env: Env) => `${env.BACKUP_PREFIX ?? ""}backups/`;
const sys = (env: Env, action: string, target?: string) =>
  audit(env, { actor: "system", action, target, requestId: crypto.randomUUID() });

async function sha256Bytes(b: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function pipe(data: BodyInit, t: CompressionStream | DecompressionStream): Promise<ArrayBuffer> {
  const stream = new Response(data).body!.pipeThrough(t as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Response(stream).arrayBuffer();
}

async function exportTable(env: Env, table: string): Promise<{ ndjson: string; rows: number }> {
  let after = 0, rows = 0;
  const parts: string[] = [];
  for (;;) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE id > ? ORDER BY id ASC LIMIT ${PAGE}`)
      .bind(after).all<Record<string, unknown> & { id: number }>();
    if (!results.length) break;
    for (const r of results) parts.push(JSON.stringify(r));
    rows += results.length;
    after = results[results.length - 1].id;
  }
  return { ndjson: parts.length ? parts.join("\n") + "\n" : "", rows };
}

export interface Manifest {
  version: 1;
  date: string;
  createdAt: string;
  auditHead: string | null;
  tables: Record<string, { key: string; rows: number; bytes: number; sha256: string }>;
}

/** CP-9: daily export of every table to R2 plus a manifest; prunes to KEEP_BACKUPS days. */
export async function runBackup(env: Env, now = new Date()): Promise<Manifest> {
  const date = now.toISOString().slice(0, 10);
  const base = `${prefix(env)}${date}/`;
  const chain = await verifyChain(env);
  const manifest: Manifest = { version: 1, date, createdAt: now.toISOString(), auditHead: chain.headHash, tables: {} };
  for (const t of TABLES) {
    const { ndjson, rows } = await exportTable(env, t);
    const gz = await pipe(ndjson, new CompressionStream("gzip"));
    const key = `${base}${t}.ndjson.gz`;
    await env.BACKUPS.put(key, gz, { httpMetadata: { contentType: "application/gzip" } });
    manifest.tables[t] = { key, rows, bytes: gz.byteLength, sha256: await sha256Bytes(gz) };
  }
  const text = JSON.stringify(manifest, null, 2);
  await env.BACKUPS.put(`${base}manifest.json`, text, { httpMetadata: { contentType: "application/json" } });
  await sys(env, "backup.completed", `manifest:${date}:${await sha256Hex(text)}`);
  await pruneBackups(env);
  return manifest;
}

async function listDates(env: Env): Promise<string[]> {
  const p = prefix(env);
  const dates: string[] = [];
  let cursor: string | undefined;
  do {
    const l = await env.BACKUPS.list({ prefix: p, delimiter: "/", cursor });
    for (const d of l.delimitedPrefixes) dates.push(d.slice(p.length, -1));
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
  return dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
}

export async function pruneBackups(env: Env): Promise<number> {
  const old = (await listDates(env)).slice(0, -KEEP_BACKUPS);
  for (const d of old) {
    let cursor: string | undefined;
    do {
      const l = await env.BACKUPS.list({ prefix: `${prefix(env)}${d}/`, cursor });
      if (l.objects.length) await env.BACKUPS.delete(l.objects.map((o) => o.key));
      cursor = l.truncated ? l.cursor : undefined;
    } while (cursor);
  }
  return old.length;
}

/** CP-4 / CP-10: re-read newest manifest, check hashes + row counts + audit chain. */
export async function runVerify(env: Env): Promise<{ ok: boolean; problems: string[]; date?: string }> {
  const problems: string[] = [];
  const dates = await listDates(env);
  const date = dates[dates.length - 1];
  if (!date) problems.push("no_backup_found");
  else {
    try {
      const mo = await env.BACKUPS.get(`${prefix(env)}${date}/manifest.json`);
      if (!mo) problems.push("manifest_missing");
      else {
        const m = (await mo.json()) as Manifest;
        for (const t of TABLES) {
          const e = m.tables?.[t];
          const obj = e && (await env.BACKUPS.get(e.key));
          if (!e || !obj) { problems.push(`${t}:object_missing`); continue; }
          const gz = await obj.arrayBuffer();
          if ((await sha256Bytes(gz)) !== e.sha256) { problems.push(`${t}:sha256_mismatch`); continue; }
          const lines = new TextDecoder().decode(await pipe(gz, new DecompressionStream("gzip"))).split("\n").filter(Boolean);
          try { lines.forEach((l) => JSON.parse(l)); } catch { problems.push(`${t}:unparseable`); continue; }
          if (lines.length !== e.rows) problems.push(`${t}:row_count_mismatch`);
        }
      }
    } catch {
      problems.push("verify_error");
    }
  }
  const chain = await verifyChain(env);
  if (!chain.ok) problems.push(`audit_chain:${chain.reason}@${chain.brokenAtId}`);
  const ok = problems.length === 0;
  await sys(env, ok ? "backup.verified" : "backup.verify_failed", `${date ?? "none"}${ok ? "" : ":" + problems.join(",")}`.slice(0, 500));
  return { ok, problems, date };
}

/** SI-12: anonymize closed/resolved tickets untouched for RETENTION_DAYS. Waitlist is kept until launch. */
export async function runRetention(env: Env, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400000).toISOString();
  const r = await env.DB.prepare(
    `UPDATE tickets SET name = 'redacted', email = 'redacted', message = '[redacted]', ip_hash = ''
     WHERE status IN ('closed','resolved') AND updated_at < ? AND email <> 'redacted'`,
  ).bind(cutoff).run();
  const n = r.meta.changes ?? 0;
  await sys(env, "retention.tickets_anonymized", `count:${n}`);
  return n;
}

export async function runScheduled(env: Env, now = new Date()): Promise<void> {
  try { await runBackup(env, now); } catch (e) {
    console.error("backup failed", e instanceof Error ? e.message : "unknown");
    await sys(env, "backup.failed").catch(() => {});
  }
  try { await runRetention(env, now); } catch (e) {
    console.error("retention failed", e instanceof Error ? e.message : "unknown");
  }
  if (now.getUTCDay() === 0) await runVerify(env);
}

export async function statusSummary(env: Env) {
  const lastBackup = await env.DB.prepare(
    "SELECT action, ts FROM audit_log WHERE action IN ('backup.completed','backup.failed') ORDER BY id DESC LIMIT 1",
  ).first<{ action: string; ts: string }>();
  const lastVerify = await env.DB.prepare(
    "SELECT ts FROM audit_log WHERE action = 'backup.verified' ORDER BY id DESC LIMIT 1",
  ).first<{ ts: string }>();
  const fresh = lastBackup && Date.now() - Date.parse(lastBackup.ts) < 36 * 3600_000;
  return {
    lastBackupOk: lastBackup?.action === "backup.completed" && !!fresh,
    lastVerifiedAt: lastVerify?.ts ?? null,
    lastBackupAt: lastBackup?.ts ?? null,
  };
}
