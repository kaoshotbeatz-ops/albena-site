import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv, User } from "../types";
import { randomToken, sha256 } from "./crypto";

export const SESSION_COOKIE = "__Host-albena_session";
export const IDLE_SECONDS = 12 * 60 * 60;
export const ABSOLUTE_SECONDS = 7 * 24 * 60 * 60;
export const now = () => Math.floor(Date.now() / 1000);
const options = { httpOnly: true, secure: true, sameSite: "Lax" as const, path: "/" };
export function clearSession(c: Context<AppEnv>) { deleteCookie(c, SESSION_COOKIE, options); }
export async function createSession(c: Context<AppEnv>, user: User): Promise<void> {
  const token = randomToken(), id = crypto.randomUUID(), ts = now();
  const old = getCookie(c, SESSION_COOKIE);
  const statements = [];
  if (old) statements.push(c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(old)));
  statements.push(c.env.DB.prepare("INSERT INTO sessions (id, token_hash, user_id, account_id, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, await sha256(token), user.id, user.accountId, ts, ts, ts + ABSOLUTE_SECONDS));
  await c.env.DB.batch(statements);
  c.set("user", user);
  c.set("sessionId", id);
  setCookie(c, SESSION_COOKIE, token, { ...options, maxAge: ABSOLUTE_SECONDS });
}
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return c.json({ error: "unauthorized" }, 401);
  const ts = now();
  // Conditional update checks expiry/revocation and refreshes idle time atomically.
  const session = await c.env.DB.prepare(
    "UPDATE sessions SET last_seen = MAX(last_seen, ?) WHERE token_hash = ? AND last_seen > ? AND expires_at > ? RETURNING id, user_id, account_id",
  ).bind(ts, await sha256(token), ts - IDLE_SECONDS, ts).first<{ id: string; user_id: string; account_id: string }>();
  if (!session) { clearSession(c); return c.json({ error: "unauthorized" }, 401); }
  const user = await c.env.DB.prepare(
    "SELECT u.id, u.email, m.role, m.account_id AS accountId FROM users u JOIN members m ON m.user_id = u.id WHERE u.id = ? AND m.account_id = ?",
  ).bind(session.user_id, session.account_id).first<User>();
  if (!user) { clearSession(c); return c.json({ error: "unauthorized" }, 401); }
  c.set("user", user);
  c.set("sessionId", session.id);
  await next();
};
export async function userById(c: Context<AppEnv>, id: string): Promise<User | null> {
  // Default to owned account. Future account switching must validate membership.
  return c.env.DB.prepare("SELECT u.id, u.email, m.role, m.account_id AS accountId FROM users u JOIN members m ON m.user_id = u.id WHERE u.id = ? ORDER BY (m.role = 'owner') DESC, m.account_id LIMIT 1").bind(id).first<User>();
}
