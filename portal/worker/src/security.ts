import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./types";
const CSP = [
  "default-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const STATIC_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/** Re-wraps any response (including immutable ASSETS responses) with security headers. */
export function withSecurityHeaders(req: Request, res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(STATIC_HEADERS)) out.headers.set(k, v);
  out.headers.delete("Server");
  out.headers.delete("X-Powered-By");
  const { pathname } = new URL(req.url);
  if (isSensitivePath(pathname)) {
    out.headers.set("Cache-Control", "no-store");
    out.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
  return out;
}

export function isSensitivePath(pathname: string): boolean {
  return (
    pathname === "/api" || pathname.startsWith("/api/") ||
    pathname === "/admin" || pathname.startsWith("/admin/")
  );
}


export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  await next();
  c.res = withSecurityHeaders(c.req.raw, c.res);
  c.header("X-Request-ID", c.get("requestId"));
  c.header("Referrer-Policy", "no-referrer");
};
/** Machine-auth routes must verify their own Stripe signature / hub credential. */
const machineRoutes = new Set(["/api/stripe/webhook", "/api/hubs/pair/complete", "/api/hubs/heartbeat"]);
export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !machineRoutes.has(c.req.path)) {
    const origin = c.req.header("Origin");
    if (c.req.header("X-Requested-With") !== "albena-portal" ||
        (origin !== undefined && origin !== c.env.PORTAL_ORIGIN) ||
        c.req.header("Sec-Fetch-Site") === "cross-site") {
      return c.json({ error: "csrf_rejected", requestId: c.get("requestId") }, 403);
    }
  }
  await next();
};
