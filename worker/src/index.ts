import { Hono } from "hono";
import type { AppEnv, Env } from "./types";
import { json, withSecurityHeaders } from "./security";
import { publicApi } from "./public";
import { runScheduled } from "./maintenance";
import { adminApi, requireAccess } from "./admin";

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  c.set("actor", "public");
  c.set("ipHash", "");
  await next();
  c.res = new Response(c.res.body, c.res);
  c.res.headers.set("X-Request-Id", c.get("requestId"));
});

app.route("/api/admin", adminApi);
app.route("/api", publicApi);
app.all("/api/*", () => json({ error: "not_found" }, 404));

// Static admin UI (if any) is served only after Access verification.
app.all("/admin", requireAccess, (c) => c.env.ASSETS.fetch(c.req.raw));
app.all("/admin/*", requireAccess, (c) => c.env.ASSETS.fetch(c.req.raw));

app.all("*", (c) => {
  const m = c.req.method;
  if (m !== "GET" && m !== "HEAD") return json({ error: "method_not_allowed" }, 405, { Allow: "GET, HEAD" });
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  console.error("unhandled", c.get("requestId"), err instanceof Error ? err.message : "unknown");
  return json({ error: "internal_error", requestId: c.get("requestId") }, 500);
});

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.hostname === "www.albena.ai") {
      url.hostname = "albena.ai";
      return withSecurityHeaders(req, Response.redirect(url.toString(), 301));
    }
    let res: Response;
    try {
      res = await app.fetch(req, env, ctx);
    } catch {
      res = json({ error: "internal_error" }, 500);
    }
    return withSecurityHeaders(req, res);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
