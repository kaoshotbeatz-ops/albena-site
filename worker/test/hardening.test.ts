import { env as rawEnv } from "cloudflare:workers";
import type { Env } from "../src/types";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { audit, sealAudit, verifyChain, repairChain, rowHash, GENESIS } from "../src/auditchain";
import { KEEP_BACKUPS, runBackup, runRetention, runScheduled, runVerify } from "../src/maintenance";

const env = rawEnv as unknown as Env;
const rid = () => crypto.randomUUID();
const add = (action: string) => audit(env, { actor: "t", action, requestId: rid() });

async function call(path: string) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://albena.ai${path}`, { headers: { "CF-Connecting-IP": "203.0.113.9" } }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function wipeBucket() {
  const l = await env.BACKUPS.list();
  if (l.objects.length) await env.BACKUPS.delete(l.objects.map((o) => o.key));
}
async function gunzip(buf: ArrayBuffer) {
  return new Response(new Response(buf).body!.pipeThrough(new DecompressionStream("gzip"))).text();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM waitlist"),
    env.DB.prepare("DELETE FROM tickets"),
    env.DB.prepare("DELETE FROM audit_log"),
  ]);
  await wipeBucket();
});

describe("audit chain fork prevention and repair", () => {
  const raw = (n: number) => env.DB.batch(Array.from({ length: n }, (_, i) => env.DB.prepare("INSERT INTO audit_log (actor, action, request_id) VALUES ('x', ?, 'r')").bind(`e${i}`)));
  const ids = async () => ((await env.DB.prepare("SELECT id FROM audit_log ORDER BY id").all()).results as any[]).map((r) => r.id as number);
  const FULL = "SELECT id, ts, actor, action, target, request_id, ip_hash, hash FROM audit_log ORDER BY id";
  const GUARDED =
    "UPDATE audit_log SET prev_hash = ?1, hash = ?2 WHERE id = ?3 AND hash IS NULL AND ((SELECT hash FROM audit_log WHERE id < ?3 ORDER BY id DESC LIMIT 1) = ?1 OR (NOT EXISTS (SELECT 1 FROM audit_log WHERE id < ?3) AND ?1 = ?4))";

  it("a sealer with a stale view cannot fork the chain", async () => {
    await raw(2); await sealAudit(env);
    await raw(3);
    // Stale sealer plans #3..#5 off head #2, but the winner seals first and then more rows land.
    const rows = (await env.DB.prepare(FULL).all()).results as any[];
    const staleBatch: D1PreparedStatement[] = [];
    let p = rows[1].hash as string;
    for (const r of rows.slice(2)) { const h = await rowHash(p, r); staleBatch.push(env.DB.prepare(GUARDED).bind(p, h, r.id, GENESIS)); p = h; }
    expect(await sealAudit(env)).toBe(3);
    await raw(1);
    const res = await env.DB.batch(staleBatch);
    expect(res.every((r) => r.meta.changes === 0)).toBe(true);
    await sealAudit(env);
    expect(await verifyChain(env)).toMatchObject({ ok: true, rows: 6, sealed: 6, unsealed: 0 });
  });

  it("sealing a later row off a stale predecessor is rejected (the #18 fork)", async () => {
    await raw(4); await sealAudit(env);
    await raw(1);
    const all = await ids();
    const r5 = (await env.DB.prepare("SELECT id, ts, actor, action, target, request_id, ip_hash FROM audit_log WHERE id = ?").bind(all[4]).first()) as any;
    const stale = (await env.DB.prepare("SELECT hash FROM audit_log WHERE id = ?").bind(all[1]).first<{ hash: string }>())!.hash;
    const r = await env.DB.prepare(GUARDED).bind(stale, await rowHash(stale, r5), all[4], GENESIS).run();
    expect(r.meta.changes).toBe(0);
    await sealAudit(env);
    expect((await verifyChain(env)).ok).toBe(true);
  });

  it("concurrent sealers with interleaved inserts never fork", async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.all([audit(env, { actor: "t", action: `p${i}`, requestId: rid() }), sealAudit(env), audit(env, { actor: "t", action: `q${i}`, requestId: rid() }), sealAudit(env)]);
    }
    await sealAudit(env);
    expect(await verifyChain(env)).toMatchObject({ ok: true, rows: 20, unsealed: 0 });
  });

  it("repairs an existing fork, records old hashes, and verifies ok", async () => {
    await raw(6); await sealAudit(env);
    const all = await ids();
    const rows = (await env.DB.prepare(FULL).all()).results as any[];
    const oldFourth = rows[3].hash as string;
    // Recreate the incident: 4th row sealed off the 1st instead of the 3rd; the rest chain off the bad one.
    let prev = rows[0].hash as string;
    const fix: D1PreparedStatement[] = [];
    for (const r of rows.slice(3)) { const h = await rowHash(prev, r); fix.push(env.DB.prepare("UPDATE audit_log SET prev_hash = ?, hash = ? WHERE id = ?").bind(prev, h, r.id)); prev = h; }
    await env.DB.batch(fix);
    expect(await verifyChain(env)).toMatchObject({ ok: false, reason: "prev_hash_mismatch", brokenAtId: all[3] });

    const r = await repairChain(env, "omar@example.com", rid());
    expect(r).toMatchObject({ repairedFrom: all[3], repairedTo: all[5] });
    expect(await verifyChain(env)).toMatchObject({ ok: true, rows: 7, unsealed: 0 });
    const rep = (await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'audit.chain.repair'").first()) as any;
    expect(rep.target).toContain(`re-sealed ids ${all[3]}..${all[5]} after concurrent-sealer fork`);
    expect(rep.hash).toBeTruthy();
    const rec = (await env.DB.prepare("SELECT * FROM audit_chain_repairs").first()) as any;
    expect(JSON.parse(rec.old_hashes)[String(all[3])]).toBeTruthy();
    expect(rec.repair_row_id).toBe(rep.id);
    expect(oldFourth).toBeTruthy();
    expect(await repairChain(env, "x", rid())).toEqual({ error: "chain_ok" });
  });

  it("refuses to 'repair' tampered content", async () => {
    await raw(3); await sealAudit(env);
    const all = await ids();
    await env.DB.prepare("UPDATE audit_log SET actor = 'evil' WHERE id = ?").bind(all[1]).run();
    const r = (await repairChain(env, "x", rid())) as any;
    expect(r.error).toMatch(/^not_repairable:hash_mismatch/);
  });
});

describe("AU-9/AU-10 audit hash chain", () => {
  it("chains rows from genesis and verifies", async () => {
    await add("a"); await add("b"); await add("c");
    const rows = (await env.DB.prepare("SELECT prev_hash, hash FROM audit_log ORDER BY id").all()).results as any[];
    expect(rows[0].prev_hash).toBe(GENESIS);
    expect(rows[1].prev_hash).toBe(rows[0].hash);
    expect(rows[2].prev_hash).toBe(rows[1].hash);
    const v = await verifyChain(env);
    expect(v).toMatchObject({ ok: true, rows: 3, sealed: 3, unsealed: 0, headHash: rows[2].hash });
  });

  it("seals rows inserted by raw SQL batches and is idempotent/concurrency-safe", async () => {
    await env.DB.batch([1, 2, 3].map((i) => env.DB.prepare("INSERT INTO audit_log (actor, action, request_id) VALUES ('x', ?, 'r')").bind(`legacy${i}`)));
    expect(await verifyChain(env)).toMatchObject({ ok: true, sealed: 0, unsealed: 3 });
    await Promise.all([sealAudit(env), sealAudit(env), sealAudit(env)]);
    expect(await verifyChain(env)).toMatchObject({ ok: true, sealed: 3, unsealed: 0 });
    expect(await sealAudit(env)).toBe(0);
  });

  it("detects a modified row", async () => {
    await add("a"); await add("b"); await add("c");
    await env.DB.prepare("UPDATE audit_log SET actor = 'evil' WHERE action = 'b'").run();
    const v = await verifyChain(env);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("hash_mismatch");
  });

  it("detects a deleted row", async () => {
    await add("a"); await add("b"); await add("c");
    await env.DB.prepare("DELETE FROM audit_log WHERE action = 'b'").run();
    const v = await verifyChain(env);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("prev_hash_mismatch");
  });

  it("detects a stripped hash in the middle", async () => {
    await add("a"); await add("b"); await add("c");
    await env.DB.prepare("UPDATE audit_log SET hash = NULL, prev_hash = NULL WHERE action = 'b'").run();
    const v = await verifyChain(env);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("sealed_row_after_unsealed");
  });
});

describe("CP-9 backups", () => {
  it("writes NDJSON.gz per table + manifest with matching hashes, and audits it", async () => {
    await env.DB.prepare("INSERT INTO waitlist (email, email_key, ip_hash) VALUES ('a@x.com','a@x.com','h')").run();
    await env.DB.prepare("INSERT INTO tickets (name, email, topic, message, ip_hash) VALUES ('n','e@x.com','t','m','h')").run();
    await add("seed");
    const m = await runBackup(env, new Date("2026-10-10T03:17:00Z"));
    expect(m.tables.waitlist.rows).toBe(1);
    expect(m.tables.tickets.rows).toBe(1);
    expect(m.tables.audit_log.rows).toBe(1);
    expect(await env.BACKUPS.get("backups/2026-10-10/manifest.json")).toBeTruthy();
    const obj = await env.BACKUPS.get("backups/2026-10-10/waitlist.ndjson.gz");
    const text = await gunzip(await obj!.arrayBuffer());
    expect(JSON.parse(text.trim()).email).toBe("a@x.com");
    const a = await env.DB.prepare("SELECT target FROM audit_log WHERE action = 'backup.completed'").first<any>();
    expect(a.target).toMatch(/^manifest:2026-10-10:[0-9a-f]{64}$/);
    expect((await verifyChain(env)).ok).toBe(true);
  });

  it("keeps only the newest 35 daily backups", async () => {
    for (let i = 1; i <= KEEP_BACKUPS + 3; i++) await runBackup(env, new Date(Date.UTC(2026, 0, i, 3, 17)));
    const l = await env.BACKUPS.list({ prefix: "backups/", delimiter: "/" });
    expect(l.delimitedPrefixes.length).toBe(KEEP_BACKUPS);
    expect(l.delimitedPrefixes).not.toContain("backups/2026-01-01/");
    expect(l.delimitedPrefixes).toContain("backups/2026-02-07/");
  });

  it("uses the configured prefix (staging)", async () => {
    const e2 = { ...env, BACKUP_PREFIX: "staging/" } as Env;
    await runBackup(e2, new Date("2026-10-10T03:17:00Z"));
    expect(await env.BACKUPS.get("staging/backups/2026-10-10/manifest.json")).toBeTruthy();
    expect(await env.BACKUPS.get("backups/2026-10-10/manifest.json")).toBeNull();
  });
});

describe("CP-4/CP-10 restore verification", () => {
  it("verifies a good backup", async () => {
    await add("seed");
    await runBackup(env, new Date("2026-10-10T03:17:00Z"));
    expect(await runVerify(env)).toMatchObject({ ok: true, date: "2026-10-10" });
    expect(await env.DB.prepare("SELECT 1 FROM audit_log WHERE action = 'backup.verified'").first()).toBeTruthy();
  });

  it("fails on a tampered object", async () => {
    await runBackup(env, new Date("2026-10-10T03:17:00Z"));
    await env.BACKUPS.put("backups/2026-10-10/tickets.ndjson.gz", new Uint8Array([1, 2, 3]));
    const r = await runVerify(env);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain("tickets:sha256_mismatch");
    expect(await env.DB.prepare("SELECT 1 FROM audit_log WHERE action = 'backup.verify_failed'").first()).toBeTruthy();
  });

  it("fails on a broken audit chain and when no backup exists", async () => {
    expect((await runVerify(env)).problems).toContain("no_backup_found");
    await add("a"); await add("b");
    await runBackup(env, new Date("2026-10-10T03:17:00Z"));
    await env.DB.prepare("UPDATE audit_log SET action = 'zzz' WHERE action = 'a'").run();
    const r = await runVerify(env);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.startsWith("audit_chain:"))).toBe(true);
  });

  it("scheduled handler verifies only on Sundays", async () => {
    await runScheduled(env, new Date("2026-10-10T03:17:00Z")); // Saturday
    expect(await env.DB.prepare("SELECT 1 FROM audit_log WHERE action LIKE 'backup.verif%'").first()).toBeNull();
    await runScheduled(env, new Date("2026-10-11T03:17:00Z")); // Sunday
    expect(await env.DB.prepare("SELECT 1 FROM audit_log WHERE action = 'backup.verified'").first()).toBeTruthy();
  });
});

describe("SI-12 retention", () => {
  const old = "2025-01-01T00:00:00.000Z";
  const mk = (status: string, updated: string, email: string) =>
    env.DB.prepare("INSERT INTO tickets (name, email, topic, message, status, ip_hash, updated_at) VALUES ('Nm', ?, 't', 'secret msg', ?, 'h', ?)")
      .bind(email, status, updated).run();

  it("anonymizes only old closed/resolved tickets and logs the count", async () => {
    await mk("closed", old, "a@x.com");
    await mk("resolved", old, "b@x.com");
    await mk("open", old, "c@x.com");
    await mk("closed", "2026-10-01T00:00:00.000Z", "d@x.com");
    await env.DB.prepare("INSERT INTO waitlist (email, email_key, ip_hash, created_at) VALUES ('w@x.com','w@x.com','h','2020-01-01')").run();
    expect(await runRetention(env, new Date("2026-10-10T00:00:00Z"))).toBe(2);
    const rows = (await env.DB.prepare("SELECT email, name, message FROM tickets ORDER BY id").all()).results as any[];
    expect(rows.map((r) => r.email)).toEqual(["redacted", "redacted", "c@x.com", "d@x.com"]);
    expect(rows[0]).toMatchObject({ name: "redacted", message: "[redacted]" });
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM waitlist").first<any>()).n).toBe(1);
    const a = await env.DB.prepare("SELECT target FROM audit_log WHERE action = 'retention.tickets_anonymized'").first<any>();
    expect(a.target).toBe("count:2");
    expect(await runRetention(env, new Date("2026-10-10T00:00:00Z"))).toBe(0); // idempotent
  });
});

describe("integrity + status endpoints", () => {
  it("GET /api/status is public and exposes only booleans/timestamps", async () => {
    let res = await call("/api/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, lastBackupOk: false, lastVerifiedAt: null });
    await runBackup(env);
    await runVerify(env);
    res = await call("/api/status");
    const body = (await res.json()) as any;
    expect(Object.keys(body).sort()).toEqual(["lastBackupOk", "lastVerifiedAt", "ok"]);
    expect(body.lastBackupOk).toBe(true);
    expect(typeof body.lastVerifiedAt).toBe("string");
  });

  it("GET /api/status reports false after a failed backup", async () => {
    await runBackup(env);
    await add("backup.failed");
    expect(((await (await call("/api/status")).json()) as any).lastBackupOk).toBe(false);
  });

  it("GET /api/admin/integrity is denied without Access", async () => {
    expect((await call("/api/admin/integrity")).status).toBe(403);
  });
});
