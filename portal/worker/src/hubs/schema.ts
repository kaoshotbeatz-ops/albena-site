// Strict hand-written validators: unknown keys are rejected so a hub (or bug) cannot smuggle personal data.
import { parseConnectors, type ConnectorStat } from "../connectors/schema";
export const MAX_BODY = 16384;
const SEMVER = /^\d+(\.\d+){1,3}([-+][0-9A-Za-z.-]{1,16})?$/;
const NAME = /^[A-Za-z0-9._-]{1,48}$/;
export const SERVICE_STATUS = ["ok", "degraded", "down", "unknown"] as const;
export const CHANNELS = ["stable", "beta"] as const;
export const EDITIONS = ["mac", "nvidia"] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
function onlyKeys(o: Obj, allowed: string[]): string | null {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) return `unknown field: ${k.slice(0, 32)}`;
  return null;
}
const oneOf = <T extends readonly string[]>(list: T, v: unknown): v is T[number] => typeof v === "string" && (list as readonly string[]).includes(v);
const ver = (v: unknown): v is string => typeof v === "string" && v.length <= 32 && SEMVER.test(v);
const prof = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9_-]{1,32}$/.test(v);

// ---- optional `stats` (operational numbers only; every string is a bounded name or an enum) ----
export const STAT_STATUS = ["ok", "down", "degraded"] as const;
export const AI_LANES = ["fast", "general", "brain", "code", "vision", "embed", "other"] as const;
export const UPDATE_RESULTS = ["ok", "rolled_back", "failed", "none"] as const;
const SVC_NAME = /^[A-Za-z0-9._-]{1,32}$/;
const LABEL = /^[A-Za-z0-9 ._:+()\/-]{1,64}$/; // hardware / model names such as "NVIDIA GeForce RTX 5080" or "nvidia/nemotron-3:q4"
const MAX_UPTIME_S = 10 * 365 * 86400;
const MAX_MB = 16 * 1024 * 1024; // 16 TB
const MAX_GB = 1_000_000;
const MAX_COUNT = 1_000_000_000;
const MAX_TS = 4_102_444_800; // year 2100

type Service = [string, (typeof STAT_STATUS)[number]] | [string, (typeof STAT_STATUS)[number], number];
export type GpuStat = { name: string; util_pct: number; mem_used_mb: number; mem_total_mb: number; temp_c?: number };
export type ModelStat = { lane: (typeof AI_LANES)[number]; name: string; loaded: boolean };
export type HubStats = {
  uptime_s?: number; cpu_pct?: number; load1?: number; mem_used_mb?: number; mem_total_mb?: number; disk_used_gb?: number; disk_total_gb?: number;
  temp_c?: number; gpu?: GpuStat[]; services?: Service[];
  ai?: { mode?: "local" | "local+cloud"; models?: ModelStat[]; avg_latency_ms?: number };
  activity?: { requests_24h?: number; requests_7d?: number; wakes_24h?: number; approvals_pending?: number; approvals_24h?: number };
  updates?: { latest_known?: string; last_result?: (typeof UPDATE_RESULTS)[number]; last_at?: number };
  /** Names and status of connections only (see ../connectors/schema.ts). Split off into hubs.connectors_json on heartbeat. */
  connectors?: ConnectorStat[];
};

const num = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const int = (v: unknown, min: number, max: number): v is number => num(v, min, max) && Number.isInteger(v);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Validates one service tuple: [name, status] or [name, status, uptime_s]. */
function parseService<S extends readonly string[]>(s: unknown, names: RegExp, statuses: S, allowThird: boolean): [string, S[number]] | [string, S[number], number] | null {
  if (!Array.isArray(s) || s.length < 2 || s.length > (allowThird ? 3 : 2) || typeof s[0] !== "string" || !names.test(s[0]) || !oneOf(statuses, s[1])) return null;
  if (s.length === 2) return [s[0], s[1]];
  return int(s[2], 0, MAX_UPTIME_S) ? [s[0], s[1], s[2]] : null;
}

export function parseStats(v: unknown): { ok: true; value: HubStats } | { ok: false; error: string } {
  const bad = (m: string) => ({ ok: false as const, error: `stats: ${m}` });
  if (!isObj(v)) return bad("must be an object");
  const e = onlyKeys(v, ["uptime_s", "cpu_pct", "load1", "mem_used_mb", "mem_total_mb", "disk_used_gb", "disk_total_gb", "temp_c", "gpu", "services", "ai", "activity", "updates", "connectors"]);
  if (e) return bad(e);
  // Every field is optional (a Hub reports only what it knows); anything present is validated.
  const out: HubStats = {};
  if ("uptime_s" in v) { if (!int(v.uptime_s, 0, MAX_UPTIME_S)) return bad("bad uptime_s"); out.uptime_s = v.uptime_s; }
  if ("cpu_pct" in v) { if (!num(v.cpu_pct, 0, 100)) return bad("bad cpu_pct"); out.cpu_pct = round1(v.cpu_pct); }
  if ("load1" in v) { if (!num(v.load1, 0, 100000)) return bad("bad load1"); out.load1 = round1(v.load1); }
  if ("mem_total_mb" in v) { if (!int(v.mem_total_mb, 0, MAX_MB)) return bad("bad memory"); out.mem_total_mb = v.mem_total_mb; }
  if ("mem_used_mb" in v) { if (!int(v.mem_used_mb, 0, out.mem_total_mb ?? MAX_MB)) return bad("bad memory"); out.mem_used_mb = v.mem_used_mb; }
  if ("disk_total_gb" in v) { if (!num(v.disk_total_gb, 0, MAX_GB)) return bad("bad disk"); out.disk_total_gb = round1(v.disk_total_gb); }
  if ("disk_used_gb" in v) { if (!num(v.disk_used_gb, 0, v.disk_total_gb !== undefined ? (v.disk_total_gb as number) : MAX_GB)) return bad("bad disk"); out.disk_used_gb = round1(v.disk_used_gb); }
  if ("temp_c" in v) { if (!num(v.temp_c, -50, 150)) return bad("bad temp_c"); out.temp_c = round1(v.temp_c); }

  if ("gpu" in v) {
    if (!Array.isArray(v.gpu) || v.gpu.length > 4) return bad("bad gpu");
    out.gpu = [];
    for (const g of v.gpu) {
      if (!isObj(g)) return bad("bad gpu entry");
      const ge = onlyKeys(g, ["name", "util_pct", "mem_used_mb", "mem_total_mb", "temp_c"]);
      if (ge) return bad(`gpu: ${ge}`);
      if (typeof g.name !== "string" || !LABEL.test(g.name) || !num(g.util_pct, 0, 100)) return bad("bad gpu entry");
      if (!int(g.mem_total_mb, 0, MAX_MB) || !int(g.mem_used_mb, 0, g.mem_total_mb)) return bad("bad gpu memory");
      const one: GpuStat = { name: g.name, util_pct: round1(g.util_pct), mem_used_mb: g.mem_used_mb, mem_total_mb: g.mem_total_mb };
      if ("temp_c" in g) { if (!num(g.temp_c, -50, 150)) return bad("bad gpu temp_c"); one.temp_c = round1(g.temp_c); }
      out.gpu.push(one);
    }
  }

  if ("services" in v) {
    if (!Array.isArray(v.services) || v.services.length > 24) return bad("bad services");
    out.services = [];
    for (const s of v.services) {
      const p = parseService(s, SVC_NAME, STAT_STATUS, true);
      if (!p) return bad("bad service entry");
      out.services.push(p);
    }
  }

  if ("ai" in v) {
    const a = v.ai;
    if (!isObj(a)) return bad("bad ai");
    const ae = onlyKeys(a, ["mode", "models", "avg_latency_ms"]);
    if (ae) return bad(`ai: ${ae}`);
    out.ai = {};
    if ("mode" in a) { if (a.mode !== "local" && a.mode !== "local+cloud") return bad("bad ai.mode"); out.ai.mode = a.mode; }
    if ("models" in a) {
    if (!Array.isArray(a.models) || a.models.length > 12) return bad("bad ai.models");
    const models: ModelStat[] = [];
    for (const m of a.models) {
      if (!isObj(m)) return bad("bad model entry");
      const me = onlyKeys(m, ["lane", "name", "loaded"]);
      if (me) return bad(`model: ${me}`);
      if (!oneOf(AI_LANES, m.lane) || typeof m.name !== "string" || !LABEL.test(m.name) || typeof m.loaded !== "boolean") return bad("bad model entry");
      models.push({ lane: m.lane, name: m.name, loaded: m.loaded });
    }
    out.ai.models = models;
    }
    if ("avg_latency_ms" in a) { if (!int(a.avg_latency_ms, 0, 3_600_000)) return bad("bad avg_latency_ms"); out.ai.avg_latency_ms = a.avg_latency_ms; }
  }

  if ("activity" in v) {
    const a = v.activity;
    const keys = ["requests_24h", "requests_7d", "wakes_24h", "approvals_pending", "approvals_24h"] as const;
    if (!isObj(a)) return bad("bad activity");
    const ae = onlyKeys(a, [...keys]);
    if (ae) return bad(`activity: ${ae}`);
    out.activity = {};
    for (const k of keys) if (k in a) { if (!int(a[k], 0, MAX_COUNT)) return bad(`bad activity.${k}`); out.activity[k] = a[k] as number; }
  }

  if ("updates" in v) {
    const u = v.updates;
    if (!isObj(u)) return bad("bad updates");
    const ue = onlyKeys(u, ["latest_known", "last_result", "last_at"]);
    if (ue) return bad(`updates: ${ue}`);
    out.updates = {};
    if ("latest_known" in u) { if (!ver(u.latest_known)) return bad("bad latest_known"); out.updates.latest_known = u.latest_known; }
    if ("last_result" in u) { if (!oneOf(UPDATE_RESULTS, u.last_result)) return bad("bad last_result"); out.updates.last_result = u.last_result; }
    if ("last_at" in u) { if (!int(u.last_at, 0, MAX_TS)) return bad("bad last_at"); out.updates.last_at = u.last_at; }
  }
  if ("connectors" in v) {
    const cs = parseConnectors(v.connectors);
    if (!cs.ok) return bad(cs.error.replace(/^connectors: /, "connectors: "));
    out.connectors = cs.value;
  }
  return { ok: true, value: out };
}

export type Heartbeat = {
  version: string; profile: string; updateChannel: "stable" | "beta";
  health: { ok: boolean; services: ([string, (typeof SERVICE_STATUS)[number]] | [string, (typeof SERVICE_STATUS)[number], number])[] };
  stats?: HubStats;
};
export function parseHeartbeat(v: unknown): { ok: true; value: Heartbeat } | { ok: false; error: string } {
  if (!isObj(v)) return { ok: false, error: "body must be an object" };
  const e = onlyKeys(v, ["version", "profile", "health", "updateChannel", "stats"]);
  if (e) return { ok: false, error: e };
  if (!ver(v.version)) return { ok: false, error: "bad version" };
  if (!prof(v.profile)) return { ok: false, error: "bad profile" };
  if (!oneOf(CHANNELS, v.updateChannel)) return { ok: false, error: "bad updateChannel" };
  const h = v.health;
  if (!isObj(h)) return { ok: false, error: "bad health" };
  const he = onlyKeys(h, ["ok", "services"]);
  if (he) return { ok: false, error: `health: ${he}` };
  if (typeof h.ok !== "boolean") return { ok: false, error: "bad health.ok" };
  if (!Array.isArray(h.services) || h.services.length > 32) return { ok: false, error: "bad health.services" };
  const services: Heartbeat["health"]["services"] = [];
  for (const s of h.services) {
    const p = parseService(s, NAME, SERVICE_STATUS, true);
    if (!p) return { ok: false, error: "bad service entry" };
    services.push(p);
  }
  const value: Heartbeat = { version: v.version, profile: v.profile, updateChannel: v.updateChannel, health: { ok: h.ok, services } };
  if ("stats" in v) {
    const st = parseStats(v.stats);
    if (!st.ok) return st;
    value.stats = st.value;
  }
  return { ok: true, value };
}

/** Exactly one credential: a pairing `code` (from the portal), a reserved `serial` (staff pre-provisioned) or a BYO `licenseKey`. */
export type PairComplete = { code?: string; serial?: string; licenseKey?: string; hubPublicKey: string; edition: "mac" | "nvidia"; profile: string; version: string };
export const SERIAL = /^[A-Z0-9][A-Z0-9._-]{3,63}$/;
export function parsePairComplete(v: unknown): { ok: true; value: PairComplete } | { ok: false; error: string } {
  if (!isObj(v)) return { ok: false, error: "body must be an object" };
  const e = onlyKeys(v, ["code", "serial", "licenseKey", "hubPublicKey", "edition", "profile", "version"]);
  if (e) return { ok: false, error: e };
  const given = (["code", "serial", "licenseKey"] as const).filter((k) => k in v);
  if (given.length !== 1) return { ok: false, error: "exactly one of code, serial, licenseKey" };
  if ("code" in v && (typeof v.code !== "string" || v.code.length > 16)) return { ok: false, error: "bad code" };
  if ("serial" in v && (typeof v.serial !== "string" || v.serial.length > 64)) return { ok: false, error: "bad serial" };
  if ("licenseKey" in v && (typeof v.licenseKey !== "string" || v.licenseKey.length > 48)) return { ok: false, error: "bad licenseKey" };
  if (typeof v.hubPublicKey !== "string" || v.hubPublicKey.length > 64) return { ok: false, error: "bad hubPublicKey" };
  if (!oneOf(EDITIONS, v.edition)) return { ok: false, error: "bad edition" };
  if (!prof(v.profile)) return { ok: false, error: "bad profile" };
  if (!ver(v.version)) return { ok: false, error: "bad version" };
  return { ok: true, value: { code: v.code as string | undefined, serial: v.serial as string | undefined, licenseKey: v.licenseKey as string | undefined, hubPublicKey: v.hubPublicKey, edition: v.edition, profile: v.profile, version: v.version } };
}

export type HubPatch = { name?: string; updateChannel?: "stable" | "beta"; remoteAccess?: boolean };
export function parseHubPatch(v: unknown): { ok: true; value: HubPatch } | { ok: false; error: string } {
  if (!isObj(v)) return { ok: false, error: "body must be an object" };
  const e = onlyKeys(v, ["name", "updateChannel", "remoteAccess"]);
  if (e) return { ok: false, error: e };
  const out: HubPatch = {};
  if ("name" in v) {
    if (typeof v.name !== "string" || v.name.trim().length < 1 || v.name.length > 60) return { ok: false, error: "bad name" };
    out.name = v.name.trim();
  }
  if ("updateChannel" in v) {
    if (!oneOf(CHANNELS, v.updateChannel)) return { ok: false, error: "bad updateChannel" };
    out.updateChannel = v.updateChannel;
  }
  if ("remoteAccess" in v) {
    if (typeof v.remoteAccess !== "boolean") return { ok: false, error: "bad remoteAccess" };
    out.remoteAccess = v.remoteAccess;
  }
  if (!Object.keys(out).length) return { ok: false, error: "nothing to update" };
  return { ok: true, value: out };
}
