// Strict validator for the heartbeat `stats.mesh` array: opaque host ids, safe labels, allowlisted part names. Never a hostname, address or path.
import { labelOk } from "../connectors/schema";

export const MESH_OS = ["macos", "linux", "windows", "unknown"] as const;
export const MESH_ROLES = ["hub", "node"] as const;
export const MESH_PART_STATES = ["running", "stopped", "unknown"] as const;
export const MESH_PARTS = ["voice", "brain", "router", "hud", "connect", "estate", "sentinel", "agent_chat", "servicenow_mcp", "vision", "embeddings", "cameras", "ollama", "openclaw"] as const;
export const MAX_HOSTS = 16;
export const MAX_PARTS = 32;
const MAX_AGE_S = 10 * 365 * 86400;

export type MeshPart = { name: (typeof MESH_PARTS)[number]; state: (typeof MESH_PART_STATES)[number] };
export type MeshHost = {
  id: string; label: string; os: (typeof MESH_OS)[number]; role: (typeof MESH_ROLES)[number]; online: boolean; last_seen_s?: number;
  hw?: { cpu?: number; ram_gb?: number; gpu?: string }; parts: MeshPart[];
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T extends readonly string[]>(list: T, v: unknown): v is T[number] => typeof v === "string" && (list as readonly string[]).includes(v);
const int = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const GPU = /^[A-Za-z0-9 ]{1,32}$/;

export function parseMesh(v: unknown): { ok: true; value: MeshHost[] } | { ok: false; error: string } {
  const bad = (m: string) => ({ ok: false as const, error: `mesh: ${m}` });
  if (!Array.isArray(v) || v.length > MAX_HOSTS) return bad("must be an array of at most 16 hosts");
  const out: MeshHost[] = [];
  const ids = new Set<string>();
  for (const x of v) {
    if (!isObj(x)) return bad("bad host");
    for (const k of Object.keys(x)) if (!["id", "label", "os", "role", "online", "last_seen_s", "hw", "parts"].includes(k)) return bad(`unknown field: ${k.slice(0, 32)}`);
    if (typeof x.id !== "string" || !/^[0-9a-f]{12}$/.test(x.id) || ids.has(x.id)) return bad("bad id");
    ids.add(x.id);
    if (!labelOk(x.label)) return bad("bad label");
    if (!oneOf(MESH_OS, x.os)) return bad("bad os");
    if (!oneOf(MESH_ROLES, x.role)) return bad("bad role");
    if (typeof x.online !== "boolean") return bad("bad online");
    const e: MeshHost = { id: x.id, label: x.label, os: x.os, role: x.role, online: x.online, parts: [] };
    if ("last_seen_s" in x) { if (!int(x.last_seen_s, 0, MAX_AGE_S)) return bad("bad last_seen_s"); e.last_seen_s = x.last_seen_s; }
    if ("hw" in x) {
      if (!isObj(x.hw)) return bad("bad hw");
      for (const k of Object.keys(x.hw)) if (!["cpu", "ram_gb", "gpu"].includes(k)) return bad("unknown hw field");
      const hw: NonNullable<MeshHost["hw"]> = {};
      if ("cpu" in x.hw) { if (!int(x.hw.cpu, 1, 4096)) return bad("bad cpu"); hw.cpu = x.hw.cpu; }
      if ("ram_gb" in x.hw) { if (!int(x.hw.ram_gb, 1, 65536)) return bad("bad ram_gb"); hw.ram_gb = x.hw.ram_gb; }
      if ("gpu" in x.hw) { if (typeof x.hw.gpu !== "string" || !GPU.test(x.hw.gpu)) return bad("bad gpu"); hw.gpu = x.hw.gpu; }
      e.hw = hw;
    }
    if (!Array.isArray(x.parts) || x.parts.length > MAX_PARTS) return bad("parts must be an array of at most 32");
    const names = new Set<string>();
    for (const p of x.parts) {
      if (!isObj(p) || Object.keys(p).some((k) => k !== "name" && k !== "state")) return bad("bad part");
      if (!oneOf(MESH_PARTS, p.name) || names.has(p.name)) return bad("bad part name");
      if (!oneOf(MESH_PART_STATES, p.state)) return bad("bad part state");
      names.add(p.name);
      e.parts.push({ name: p.name, state: p.state });
    }
    out.push(e);
  }
  return { ok: true, value: out };
}

export function parseMeshStored(json: string | null): MeshHost[] | null {
  if (!json) return null;
  try { return JSON.parse(json) as MeshHost[]; } catch { return null; }
}
