import type { Context } from "hono";
import type { AppEnv } from "../types";
import { privacyHash } from "./crypto";

export async function allowed(c: Context<AppEnv>, email?: string): Promise<boolean> {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
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
