import type { Context, Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../types";
import { audit } from "../auditchain";
import { randomToken, sha256, equalHash, randomCode } from "./crypto";
import { allowed, turnstile } from "./limits";
import { sendMail } from "./mail";
import { createSession, now, userById } from "./sessions";
import { joinHousehold } from "../account/household";

const COOKIE = "__Host-albena_magic";
const cookieOptions = { httpOnly: true, secure: true, sameSite: "Lax" as const, path: "/", maxAge: 900 };
const MAX_ATTEMPTS = 5;
const accepted = { ok: true, message: "If this address can receive mail, a sign-in link will arrive shortly." };
/** Issues a magic token bound to this browser (cookie) and emails the link and code. Delivery failure deletes the token. */
export async function startMagic(c: Context<AppEnv>, email: string): Promise<void> {
  const secret = randomToken(), id = crypto.randomUUID(), browser = randomToken(), code = randomCode();
  await c.env.DB.prepare("INSERT INTO magic_tokens (id, token_hash, browser_hash, email, expires_at, code_hash) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, await sha256(secret), await sha256(browser), email, now() + 900, await sha256(`${id}:${code}`)).run();
  setCookie(c, COOKIE, browser, cookieOptions);
  try {
    await sendMail(c.env, { to: email, url: `${c.env.PORTAL_ORIGIN}/api/auth/magic/verify?token=${id}.${secret}`, code });
  } catch {
    await c.env.DB.prepare("DELETE FROM magic_tokens WHERE id = ?").bind(id).run();
    await audit(c, "auth.magic.delivery_failed", id);
  }
}
export const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;
export function mountMagic(app: Hono<AppEnv>): void {
  app.post("/api/auth/magic/start", async c => {
    const body = await c.req.json<{ email?: unknown; turnstileToken?: unknown }>();
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    // Restrict to a conservative mailbox grammar, also preventing MIME header injection.
    if (email.length > 254 || !EMAIL_RE.test(email) ||
      typeof body.turnstileToken !== "string" || body.turnstileToken.length > 2048) return c.json({ error: "invalid_request" }, 400);
    if (!(await allowed(c, email))) return c.json(accepted, 202);
    if (!(await turnstile(c, body.turnstileToken))) return c.json({ error: "challenge_failed" }, 400);
    await startMagic(c, email);
    // Identical path for existing/new users; users are created only after verification.
    return c.json(accepted, 202);
  });
  app.get("/api/auth/magic/verify", async c => {
    if (!(await allowed(c))) return c.json({ error: "rate_limited" }, 429);
    const token = c.req.query("token") ?? "";
    const browser = getCookie(c, COOKIE) ?? "";
    const [id, secret, extra] = token.split(".");
    const bad = () => c.json({ error: "invalid_or_expired_link" }, 400);
    if (extra !== undefined || !id || !/^[a-f0-9-]{36}$/.test(id) || !secret || !/^[a-f0-9]{64}$/.test(secret) || !/^[a-f0-9]{64}$/.test(browser)) return bad();
    const row = await c.env.DB.prepare("SELECT token_hash, browser_hash FROM magic_tokens WHERE id = ?").bind(id).first<{ token_hash: string; browser_hash: string }>();
    const hash = await sha256(secret), browserHash = await sha256(browser);
    const tokenMatches = equalHash(hash, row?.token_hash ?? "0".repeat(64));
    const browserMatches = equalHash(browserHash, row?.browser_hash ?? "0".repeat(64));
    if (!tokenMatches || !browserMatches) return bad();
    // DELETE RETURNING is the single-use gate, including simultaneous requests.
    const consumed = await c.env.DB.prepare("DELETE FROM magic_tokens WHERE id = ? AND token_hash = ? AND browser_hash = ? AND expires_at > ? RETURNING email")
      .bind(id, hash, browserHash, now()).first<{ email: string }>();
    if (!consumed) return bad();
    await finishLogin(c, consumed.email);
    return c.redirect("/", 303);
  });
  app.post("/api/auth/magic/code", async c => {
    if (!(await allowed(c))) return c.json({ error: "rate_limited" }, 429);
    const body = await c.req.json<{ id?: unknown; code?: unknown }>().catch(() => null);
    const code = typeof body?.code === "string" ? body.code.replace(/[\s-]/g, "") : "";
    if (!/^\d{6}$/.test(code) || (body?.id !== undefined && typeof body.id !== "string")) return c.json({ error: "invalid_code" }, 400);
    const bad = () => c.json({ error: "invalid_or_expired_code" }, 400);
    const browser = getCookie(c, COOKIE) ?? "";
    if (!/^[a-f0-9]{64}$/.test(browser)) return bad();
    const browserHash = await sha256(browser), ts = now();
    // Cookie-bound lookup: the code alone is useless. Attempts are counted atomically before comparing.
    const row = await c.env.DB.prepare(
      "UPDATE magic_tokens SET attempts = attempts + 1 WHERE id = (SELECT id FROM magic_tokens WHERE browser_hash = ? AND code_hash IS NOT NULL AND expires_at > ? AND attempts < ? ORDER BY created_at DESC LIMIT 1) AND attempts < ? RETURNING id, code_hash, attempts")
      .bind(browserHash, ts, MAX_ATTEMPTS, MAX_ATTEMPTS).first<{ id: string; code_hash: string; attempts: number }>();
    if (!row || (typeof body?.id === "string" && body.id !== row.id)) return bad();
    const hash = await sha256(`${row.id}:${code}`);
    if (!equalHash(hash, row.code_hash)) {
      if (row.attempts >= MAX_ATTEMPTS) {
        await c.env.DB.prepare("DELETE FROM magic_tokens WHERE id = ?").bind(row.id).run();
        await audit(c, "auth.magic.code_locked", row.id);
        return c.json({ error: "too_many_attempts" }, 400);
      }
      return c.json({ error: "wrong_code", attemptsLeft: MAX_ATTEMPTS - row.attempts }, 400);
    }
    const consumed = await c.env.DB.prepare("DELETE FROM magic_tokens WHERE id = ? AND code_hash = ? AND browser_hash = ? AND expires_at > ? RETURNING email")
      .bind(row.id, hash, browserHash, now()).first<{ email: string }>();
    if (!consumed) return bad();
    await finishLogin(c, consumed.email);
    return c.json({ ok: true });
  });
}

/** Shared by link verify and code entry: create the user/account on first login, then the session. */
async function finishLogin(c: Context<AppEnv>, email: string): Promise<void> {
    await c.env.DB.prepare("INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)").bind(crypto.randomUUID(), email).run();
    const made = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
    // A pending household invite for this email makes them a member of that account instead of getting an account of their own.
    if (made) await joinHousehold(c, made.id, email);
    await c.env.DB.batch([
      // Own account only for someone with no membership at all (a household member keeps just the household).
      c.env.DB.prepare("INSERT OR IGNORE INTO accounts (id, owner) SELECT id, id FROM users WHERE email = ? AND NOT EXISTS (SELECT 1 FROM members WHERE user_id = users.id)").bind(email),
      c.env.DB.prepare("INSERT OR IGNORE INTO members (account_id, user_id, role) SELECT a.id, u.id, 'owner' FROM users u JOIN accounts a ON a.owner = u.id WHERE u.email = ?").bind(email),
    ]);
    const u = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
    const user = u && await userById(c, u.id);
    if (!user) throw new Error("user_creation_failed");
    await createSession(c, user);
    deleteCookie(c, COOKIE, cookieOptions);
    await audit(c, "auth.login.magic", user.id);
}
