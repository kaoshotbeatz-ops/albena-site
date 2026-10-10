// Hub telemetry: latest snapshot (hubs.stats_json), a thin time series (hub_metrics) and the read endpoints' shared queries.
import type { HubStats } from "./schema";

export const ONLINE_S = 15 * 60; // a Hub is online when its last heartbeat is newer than this
export const METRIC_GAP_S = 5 * 60; // at most one stored point per Hub per 5 minutes
export const METRIC_RETAIN_S = 8 * 24 * 3600;
export const MAX_POINTS = 300;
export const RANGES = { "24h": 24 * 3600, "7d": 7 * 24 * 3600 } as const;
export type Range = keyof typeof RANGES;
export type MetricPoint = { ts: number; cpu: number | null; mem_pct: number | null; gpu_util: number | null; gpu_mem_pct: number | null; latency_ms: number | null };

export const isOnline = (lastSeen: number | null, t = Math.floor(Date.now() / 1000)) => lastSeen !== null && t - lastSeen < ONLINE_S;
const pct = (used: number | undefined, total: number | undefined) => (used !== undefined && total !== undefined && total > 0 ? Math.round((used / total) * 1000) / 10 : null);

export function parseStored(json: string | null): HubStats | null {
  if (!json) return null;
  try { return JSON.parse(json) as HubStats; } catch { return null; }
}

/** The compact numbers shown on list cards. */
export function summarize(s: HubStats | null) {
  return s ? { cpu_pct: s.cpu_pct ?? null, mem_used_mb: s.mem_used_mb ?? null, mem_total_mb: s.mem_total_mb ?? null } : null;
}

/** Stores one point unless this Hub already has one in the last 5 minutes (a single atomic INSERT ... WHERE NOT EXISTS). */
export async function recordMetric(db: D1Database, hubId: string, s: HubStats, ts: number): Promise<void> {
  const gpus = s.gpu ?? [];
  const gpuUtil = gpus.length ? Math.max(...gpus.map((g) => g.util_pct)) : null;
  const gpuMem = gpus.length ? Math.max(...gpus.map((g) => pct(g.mem_used_mb, g.mem_total_mb) ?? 0)) : null;
  await db.prepare(
    `INSERT INTO hub_metrics(hub_id, ts, cpu, mem_pct, gpu_util, gpu_mem_pct, latency_ms)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
     WHERE NOT EXISTS (SELECT 1 FROM hub_metrics WHERE hub_id = ?1 AND ts > ?2 - ?8)`,
  ).bind(hubId, ts, s.cpu_pct ?? null, pct(s.mem_used_mb, s.mem_total_mb), gpuUtil, gpuMem, s.ai?.avg_latency_ms ?? null, METRIC_GAP_S).run();
}

/** Averages points into at most `max` equal time buckets over [from, to]. A bucket's ts is its start; null columns stay null. */
export function downsample(points: MetricPoint[], from: number, to: number, max = MAX_POINTS): MetricPoint[] {
  if (points.length <= max) return points;
  const size = Math.max(1, Math.ceil((to - from) / max));
  const keys = ["cpu", "mem_pct", "gpu_util", "gpu_mem_pct", "latency_ms"] as const;
  const buckets = new Map<number, { sums: number[]; counts: number[] }>();
  for (const p of points) {
    const i = Math.min(max - 1, Math.max(0, Math.floor((p.ts - from) / size)));
    let b = buckets.get(i);
    if (!b) buckets.set(i, (b = { sums: keys.map(() => 0), counts: keys.map(() => 0) }));
    keys.forEach((k, j) => { const v = p[k]; if (v !== null) { b!.sums[j] += v; b!.counts[j]++; } });
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([i, b]) => {
    const avg = (j: number) => (b.counts[j] ? Math.round((b.sums[j] / b.counts[j]) * 10) / 10 : null);
    return { ts: from + i * size, cpu: avg(0), mem_pct: avg(1), gpu_util: avg(2), gpu_mem_pct: avg(3), latency_ms: avg(4) !== null ? Math.round(avg(4)!) : null };
  });
}

export async function loadMetrics(db: D1Database, hubId: string, range: Range, t = Math.floor(Date.now() / 1000)) {
  const from = t - RANGES[range];
  const rows = (await db.prepare("SELECT ts, cpu, mem_pct, gpu_util, gpu_mem_pct, latency_ms FROM hub_metrics WHERE hub_id = ? AND ts >= ? ORDER BY ts").bind(hubId, from).all<MetricPoint>()).results ?? [];
  return { range, from, to: t, points: downsample(rows, from, t) };
}

/** Detail view of one Hub. `accountId` null = no account restriction (staff routes). Returns null when not found. */
export async function loadDetail(db: D1Database, hubId: string, accountId: string | null) {
  const row = await db.prepare(`SELECT * FROM hubs WHERE id = ?1 AND (?2 IS NULL OR account_id = ?2)`).bind(hubId, accountId).first<any>();
  if (!row) return null;
  return {
    id: row.id, accountId: row.account_id as string, name: row.name, edition: row.edition, profile: row.profile, version: row.version,
    updateChannel: row.update_channel, remoteAccess: !!row.remote_access,
    health: row.health_json ? JSON.parse(row.health_json) : null, stats: parseStored(row.stats_json),
    lastSeen: row.last_seen as number | null, online: isOnline(row.last_seen), createdAt: row.created_at,
  };
}
