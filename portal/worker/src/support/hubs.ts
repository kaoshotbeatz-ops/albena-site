import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { audit } from "../auditchain";
import { loadConnectors } from "../connectors";
import { RANGES, loadDetail, loadMetrics, loadModuleMetrics, type Range } from "../hubs/stats";

/** Read-only Hub telemetry for staff, any account. Mounted behind the Cloudflare Access + allowlist gate. */
export function mountHubs(app: Hono<AppEnv>): void {
  app.get("/support/hubs/:id", (c) => c.env.ASSETS.fetch(new Request(new URL("/support/hub", c.req.url), { headers: c.req.raw.headers })));

  app.get("/api/support/hubs/:id", async (c) => {
    const hub = await loadDetail(c.env.DB, c.req.param("id"), null, true);
    if (!hub) return c.json({ error: "not_found" }, 404);
    await audit(c, "support.hub.view", hub.id);
    return c.json({ hub });
  });

  app.get("/api/support/hubs/:id/metrics", async (c) => {
    const range = c.req.query("range") ?? "24h";
    if (!(range in RANGES)) return c.json({ error: "bad_range" }, 400);
    const hub = await loadDetail(c.env.DB, c.req.param("id"), null);
    if (!hub) return c.json({ error: "not_found" }, 404);
    return c.json(await loadMetrics(c.env.DB, hub.id, range as Range));
  });

  app.get("/api/support/hubs/:id/modules", async (c) => {
    const range = c.req.query("range") ?? "24h";
    if (!(range in RANGES)) return c.json({ error: "bad_range" }, 400);
    const hub = await loadDetail(c.env.DB, c.req.param("id"), null);
    if (!hub) return c.json({ error: "not_found" }, 404);
    return c.json(await loadModuleMetrics(c.env.DB, hub.id, range as Range));
  });

  // Same merged view the customer gets, for any account; audited, read-only.
  app.get("/api/support/accounts/:id/connectors", async (c) => {
    const id = c.req.param("id");
    if (!(await c.env.DB.prepare("SELECT 1 AS x FROM accounts WHERE id = ?").bind(id).first())) return c.json({ error: "not_found" }, 404);
    await audit(c, "support.connectors.view", id);
    return c.json(await loadConnectors(c.env.DB, id));
  });
}
