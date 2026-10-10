import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { audit } from "../auditchain";
import { RANGES, loadDetail, loadMetrics, type Range } from "../hubs/stats";

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
}
