// Connections visibility (phase 1): what each Hub reports about its connectors, merged with the catalog. Read-only; no control path.
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { requireUser } from "../auth";
import { isOnline } from "../hubs/stats";
import { CATALOG, CATEGORIES } from "./catalog";
import { CUSTOM_ID, type ConnectorStat } from "./schema";

export const migrations: string[] = []; // the column lives on hubs (0800_hub_connectors.sql, listed by the hubs module)

export type HubState = Omit<ConnectorStat, "id" | "label"> & { hubId: string };

/** Catalog entries with each of the account's Hubs' reported state, plus custom (mcp/rest) connections per Hub. */
export async function loadConnectors(db: D1Database, accountId: string) {
  const rows = (await db.prepare("SELECT id, name, last_seen, connectors_json FROM hubs WHERE account_id = ? ORDER BY created_at").bind(accountId).all<any>()).results ?? [];
  const byCatalog = new Map<string, HubState[]>();
  const custom: (ConnectorStat & { hubId: string })[] = [];
  const hubs = rows.map((h) => {
    let list: ConnectorStat[] | null = null;
    try { list = h.connectors_json ? (JSON.parse(h.connectors_json) as ConnectorStat[]) : null; } catch { list = null; }
    for (const x of list ?? []) {
      if (x.id === CUSTOM_ID) { custom.push({ ...x, hubId: h.id }); continue; }
      const { id, label: _l, ...rest } = x;
      (byCatalog.get(id) ?? byCatalog.set(id, []).get(id)!).push({ ...rest, hubId: h.id });
    }
    return { id: h.id as string, name: h.name as string, online: isOnline(h.last_seen), lastSeen: h.last_seen as number | null, reported: list !== null };
  });
  return {
    categories: CATEGORIES,
    catalog: CATALOG.map((e) => ({ ...e, hubs: byCatalog.get(e.id) ?? [] })),
    custom,
    hubs,
  };
}

export function mount(app: Hono<AppEnv>): void {
  // Owner and members (and read-only view-as sessions) see their own account's Hubs only.
  app.get("/api/connectors", requireUser, async (c) => c.json(await loadConnectors(c.env.DB, c.get("user").accountId)));
}
