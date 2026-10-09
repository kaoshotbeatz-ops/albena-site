import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv, Bindings } from "./types";
import { scheduled } from "./cron";
import { modules } from "./modules";
import { csrf, securityHeaders } from "./security";

export const app = new Hono<AppEnv>();
app.use("*", securityHeaders);
app.use("/api/*", bodyLimit({ maxSize: 64 * 1024, onError: c => c.json({ error: "body_too_large" }, 413) }));
app.use("/api/*", csrf);
for (const module of modules) module.mount(app);
// The Astro UI is static assets; the worker runs first so every response gets the security headers.
app.notFound(c => {
  if (!c.req.path.startsWith("/api/") && ["GET", "HEAD"].includes(c.req.method) && c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.json({ error: "not_found", requestId: c.get("requestId") }, 404);
});
app.onError((err, c) => {
  const status = err instanceof HTTPException ? err.status : err instanceof SyntaxError ? 400 : 500;
  // Never log raw exception messages: providers can include tokens or email payloads.
  return c.json({ error: status === 500 ? "internal_error" : "request_rejected", requestId: c.get("requestId") }, status);
});
export { requireUser } from "./auth";
export { audit } from "./auditchain";
export type { AppEnv } from "./types";
export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Bindings>;
