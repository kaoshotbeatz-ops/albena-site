// Strict validator for the heartbeat `stats.connectors` array. Names and status only: never a secret, URL, host or address.
import { catalogEntry } from "./catalog";

export const CONNECTOR_STATES = ["connected", "needs_attention", "off"] as const;
export const CONNECTOR_ACCESS = ["read", "write"] as const;
export const CONNECTOR_KINDS = ["builtin", "mcp", "rest"] as const;
export const MAX_CONNECTORS = 60;
export const MAX_LAST_USED_H = 8760; // one year; anything older is just "a long time"
export const CUSTOM_ID = "custom";

export type ConnectorStat = {
  id: string; state: (typeof CONNECTOR_STATES)[number]; access: (typeof CONNECTOR_ACCESS)[number]; kind: (typeof CONNECTOR_KINDS)[number];
  label?: string; last_used_h?: number;
};

const LABEL_CHARS = /^[A-Za-z0-9][A-Za-z0-9 _()+&'-]{0,46}[A-Za-z0-9)]$|^[A-Za-z0-9]$/;
// Anything that looks like an address: '@', a scheme, "www", a dotted name ending in a TLD-ish word, an IPv4, a path or port.
const ADDRESS_LIKE = /@|:\/\/|\bwww\b|\.[A-Za-z]{2,}\b|\b\d{1,3}(\.\d{1,3}){3}\b|[/\\:]/i;

/** True when a free-text label is safe to store: short, plain words, nothing that looks like a URL, host, IP or e-mail. */
export function labelOk(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= 48 && v === v.trim() && !ADDRESS_LIKE.test(v) && LABEL_CHARS.test(v);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T extends readonly string[]>(list: T, v: unknown): v is T[number] => typeof v === "string" && (list as readonly string[]).includes(v);

export function parseConnectors(v: unknown): { ok: true; value: ConnectorStat[] } | { ok: false; error: string } {
  const bad = (m: string) => ({ ok: false as const, error: `connectors: ${m}` });
  if (!Array.isArray(v) || v.length > MAX_CONNECTORS) return bad("must be an array of at most 60");
  const out: ConnectorStat[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    if (!isObj(x)) return bad("bad entry");
    for (const k of Object.keys(x)) if (!["id", "label", "state", "access", "last_used_h", "kind"].includes(k)) return bad(`unknown field: ${k.slice(0, 32)}`);
    if (typeof x.id !== "string") return bad("bad id");
    if (!oneOf(CONNECTOR_STATES, x.state)) return bad("bad state");
    if (!oneOf(CONNECTOR_ACCESS, x.access)) return bad("bad access");
    if (!oneOf(CONNECTOR_KINDS, x.kind)) return bad("bad kind");
    const custom = x.id === CUSTOM_ID;
    const entry = custom ? undefined : catalogEntry(x.id);
    if (!custom && !entry) return bad("unknown id");
    // "custom" is always an mcp or rest connection the customer added themselves; a catalog id may be any kind.
    if (custom && x.kind === "builtin") return bad("custom connectors are mcp or rest");
    if (entry && x.access === "write" && !entry.write) return bad("access: write is not available for this connector");
    const e: ConnectorStat = { id: x.id, state: x.state, access: x.access, kind: x.kind };
    if ("label" in x) {
      if (x.kind === "builtin") return bad("label is only for mcp, rest and custom connectors");
      if (!labelOk(x.label)) return bad("bad label");
      e.label = x.label;
    } else if (custom) return bad("custom connectors need a label");
    if ("last_used_h" in x) {
      if (typeof x.last_used_h !== "number" || !Number.isInteger(x.last_used_h) || x.last_used_h < 0 || x.last_used_h > MAX_LAST_USED_H) return bad("bad last_used_h");
      e.last_used_h = x.last_used_h;
    }
    const key = custom ? `custom:${e.label!.toLowerCase()}` : x.id;
    if (seen.has(key)) return bad("duplicate entry");
    seen.add(key);
    out.push(e);
  }
  return { ok: true, value: out };
}
