// Strict hand-written validators: unknown keys are rejected so a hub (or bug) cannot smuggle personal data.
export const MAX_BODY = 4096;
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

export type Heartbeat = {
  version: string; profile: string; updateChannel: "stable" | "beta";
  health: { ok: boolean; services: [string, (typeof SERVICE_STATUS)[number]][] };
};
export function parseHeartbeat(v: unknown): { ok: true; value: Heartbeat } | { ok: false; error: string } {
  if (!isObj(v)) return { ok: false, error: "body must be an object" };
  const e = onlyKeys(v, ["version", "profile", "health", "updateChannel"]);
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
  const services: [string, (typeof SERVICE_STATUS)[number]][] = [];
  for (const s of h.services) {
    if (!Array.isArray(s) || s.length !== 2 || typeof s[0] !== "string" || !NAME.test(s[0]) || !oneOf(SERVICE_STATUS, s[1]))
      return { ok: false, error: "bad service entry" };
    services.push([s[0], s[1]]);
  }
  return { ok: true, value: { version: v.version, profile: v.profile, updateChannel: v.updateChannel, health: { ok: h.ok, services } } };
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
