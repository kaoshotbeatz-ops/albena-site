import type { Context } from "hono";
import type { AppEnv } from "../types";
import { privacyHash } from "./crypto";

/** Rate-limit identity for a client address: IPv4 as is; IPv6 collapsed to its /64 so one subscriber cannot rotate through its whole prefix. */
export function ipBucket(ip: string): string {
  if (!ip.includes(":")) return ip;
  const v4 = ip.match(/^(?:.*:)(\d{1,3}(?:\.\d{1,3}){3})$/); // ::ffff:1.2.3.4 and similar
  if (v4) return v4[1];
  const addr = ip.split("%")[0].toLowerCase();
  const [head, tail, extra] = addr.split("::");
  if (extra !== undefined) return ip;
  const left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  if (groups.length !== 8 || !groups.every(g => /^[0-9a-f]{1,4}$/.test(g))) return ip;
  return `${groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(":")}::/64`;
}
export async function allowed(c: Context<AppEnv>, email?: string): Promise<boolean> {
  const ip = ipBucket(c.req.header("CF-Connecting-IP") ?? "unknown");
  const ipKey = await privacyHash(c.env.PORTAL_SECRETS, `ip:${ip}`);
  const checks = [c.env.AUTH_IP_LIMITER.limit({ key: ipKey })];
  if (email) checks.push(c.env.AUTH_EMAIL_LIMITER.limit({ key: await privacyHash(c.env.PORTAL_SECRETS, `email:${email}`) }));
  return (await Promise.all(checks)).every(result => result.success);
}
export async function turnstile(c: Context<AppEnv>, token: string): Promise<boolean> {
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", body: new URLSearchParams({ secret: c.env.TURNSTILE_SECRET_KEY, response: token, remoteip: c.req.header("CF-Connecting-IP") ?? "" }),
    });
    if (!response.ok) return false;
    const result = await response.json<{ success?: boolean; hostname?: string; action?: string }>();
    return result.success === true && result.hostname === new URL(c.env.PORTAL_ORIGIN).hostname && result.action === "magic_login";
  } catch { return false; }
}
