import type { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../types";
import { audit } from "../auditchain";
import { randomToken, sha256, equalHash } from "./crypto";
import { allowed, turnstile } from "./limits";
import { sendMail } from "./mail";
import { createSession, now, userById } from "./sessions";

const COOKIE = "__Host-albena_magic";
const cookieOptions = { httpOnly: true, secure: true, sameSite: "Lax" as const, path: "/", maxAge: 900 };
const accepted = { ok: true, message: "If this address can receive mail, a sign-in link will arrive shortly." };
export function mountMagic(app: Hono<AppEnv>): void {
  app.post("/api/auth/magic/start", async c => {
    const body = await c.req.json<{ email?: unknown; turnstileToken?: unknown }>();
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    // Restrict to a conservative mailbox grammar, also preventing MIME header injection.
    if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email) ||
      typeof body.turnstileToken !== "string" || body.turnstileToken.length > 2048) return c.json({ error: "invalid_request" }, 400);
    if (!(await allowed(c, email))) return c.json(accepted, 202);
    if (!(await turnstile(c, body.turnstileToken))) return c.json({ error: "challenge_failed" }, 400);
    const secret = randomToken(), id = crypto.randomUUID(), browser = randomToken();
    await c.env.DB.prepare("INSERT INTO magic_tokens (id, token_hash, browser_hash, email, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, await sha256(secret), await sha256(browser), email, now() + 900).run();
    setCookie(c, COOKIE, browser, cookieOptions);
    try {
      await sendMail(c.env, { to: email, url: `${c.env.PORTAL_ORIGIN}/api/auth/magic/verify?token=${id}.${secret}` });
    } catch {
      await c.env.DB.prepare("DELETE FROM magic_tokens WHERE id = ?").bind(id).run();
      await audit(c, "auth.magic.delivery_failed", id);
    }
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
    const userId = crypto.randomUUID();
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)").bind(userId, consumed.email),
      c.env.DB.prepare("INSERT OR IGNORE INTO accounts (id, owner) SELECT id, id FROM users WHERE email = ?").bind(consumed.email),
      c.env.DB.prepare("INSERT OR IGNORE INTO members (account_id, user_id, role) SELECT a.id, u.id, 'owner' FROM users u JOIN accounts a ON a.owner = u.id WHERE u.email = ?").bind(consumed.email),
    ]);
    const u = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(consumed.email).first<{ id: string }>();
    const user = u && await userById(c, u.id);
    if (!user) throw new Error("user_creation_failed");
    await createSession(c, user);
    deleteCookie(c, COOKIE, cookieOptions);
    await audit(c, "auth.login.magic", user.id);
    return c.redirect("/", 303);
  });
}
