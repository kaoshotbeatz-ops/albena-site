const CSP = [
  "default-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
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
    // no-transform stops Cloudflare auto-injecting the Web Analytics beacon (owner-only/API paths; CSP blocks it anyway).
    out.headers.set("Cache-Control", "no-store, no-transform");
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

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(headers as object) },
  });
}
