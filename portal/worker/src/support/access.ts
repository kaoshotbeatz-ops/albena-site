import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Bindings } from "../types";
import { audit } from "../auditchain";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Verifies the Cloudflare Access JWT (RS256, issuer + audience) and the staff allowlist. Returns the email, or null (deny). */
export async function verifySupportAdmin(req: Request, env: Bindings): Promise<string | null> {
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  const team = env.TEAM_DOMAIN, aud = env.ADMIN_AUD;
  const allow = (env.SUPPORT_ADMIN_EMAILS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!token || !team || !aud || !allow.length) return null; // deny by default
  try {
    let jwks = jwksCache.get(team);
    if (!jwks) { jwks = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`)); jwksCache.set(team, jwks); }
    const { payload } = await jwtVerify(token, jwks, { issuer: `https://${team}`, audience: aud, algorithms: ["RS256"] });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    return email && allow.includes(email) ? email : null;
  } catch {
    return null;
  }
}

export const requireSupportAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const email = await verifySupportAdmin(c.req.raw, c.env);
  if (!email) {
    await audit(c, "support.access.denied", c.req.path).catch(() => {});
    return c.json({ error: "forbidden" }, 403);
  }
  c.set("supportActor", email);
  await next();
};
