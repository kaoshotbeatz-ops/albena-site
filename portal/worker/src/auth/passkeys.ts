import type { Context, Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
  type RegistrationResponseJSON, type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import type { AppEnv } from "../types";
import { audit } from "../auditchain";
import { randomToken, sha256 } from "./crypto";
import { allowed } from "./limits";
import { requireUser, createSession, now, userById } from "./sessions";

const COOKIE = "__Host-albena_passkey";
const cookieOptions = { httpOnly: true, secure: true, sameSite: "Strict" as const, path: "/", maxAge: 300 };
type Challenge = { challenge: string; user_id: string | null; session_id: string | null };
async function saveChallenge(c: Context<AppEnv>, challenge: string, kind: "register" | "login") {
  const id = crypto.randomUUID(), browser = randomToken();
  await c.env.DB.prepare("INSERT INTO auth_challenges (id, challenge, kind, user_id, session_id, browser_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, challenge, kind, kind === "register" ? c.get("user").id : null, kind === "register" ? c.get("sessionId") : null, await sha256(browser), now() + 300).run();
  setCookie(c, COOKIE, `${id}.${browser}`, cookieOptions);
}
async function consumeChallenge(c: Context<AppEnv>, kind: "register" | "login"): Promise<Challenge | null> {
  const [id, browser, extra] = (getCookie(c, COOKIE) ?? "").split(".");
  if (!id || !browser || extra !== undefined || !/^[a-f0-9]{64}$/.test(browser)) return null;
  const row = await c.env.DB.prepare("DELETE FROM auth_challenges WHERE id = ? AND browser_hash = ? AND kind = ? AND expires_at > ? RETURNING challenge, user_id, session_id")
    .bind(id, await sha256(browser), kind, now()).first<Challenge>();
  deleteCookie(c, COOKIE, cookieOptions);
  if (kind === "register" && (row?.user_id !== c.get("user").id || row?.session_id !== c.get("sessionId"))) return null;
  return row;
}
export function mountPasskeys(app: Hono<AppEnv>): void {
  app.use("/api/auth/passkey/*", async (c, next) => {
    if (!(await allowed(c))) return c.json({ error: "rate_limited" }, 429);
    await next();
  });
  app.post("/api/auth/passkey/register/options", requireUser, async c => {
    const user = c.get("user");
    const { results } = await c.env.DB.prepare("SELECT id FROM passkeys WHERE user_id = ?").bind(user.id).all<{ id: string }>();
    const options = await generateRegistrationOptions({ rpName: "Albena", rpID: c.env.RP_ID,
      userID: new TextEncoder().encode(user.id), userName: user.email, attestationType: "none",
      excludeCredentials: results.map(p => ({ id: p.id })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    await saveChallenge(c, options.challenge, "register");
    return c.json(options);
  });
  app.post("/api/auth/passkey/register/verify", requireUser, async c => {
    const challenge = await consumeChallenge(c, "register");
    if (!challenge) return c.json({ error: "invalid_challenge" }, 400);
    const response = await c.req.json<RegistrationResponseJSON>();
    let verification;
    try {
      verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge,
        expectedOrigin: c.env.PORTAL_ORIGIN, expectedRPID: c.env.RP_ID, requireUserVerification: true });
    } catch { return c.json({ error: "invalid_passkey" }, 400); }
    if (!verification.verified || !verification.registrationInfo) return c.json({ error: "invalid_passkey" }, 400);
    const { credential } = verification.registrationInfo;
    const saved = await c.env.DB.prepare("INSERT INTO passkeys (id, user_id, public_key, counter) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
      .bind(credential.id, c.get("user").id, new Uint8Array(credential.publicKey), credential.counter).run();
    if (!saved.meta.changes) return c.json({ error: "credential_exists" }, 409);
    await audit(c, "auth.passkey.register", c.get("user").id);
    return c.json({ ok: true });
  });
  // Discoverable credentials: no email or credential list is exposed before login.
  app.post("/api/auth/passkey/login/options", async c => {
    const options = await generateAuthenticationOptions({ rpID: c.env.RP_ID, userVerification: "required" });
    await saveChallenge(c, options.challenge, "login");
    return c.json(options);
  });
  app.post("/api/auth/passkey/login/verify", async c => {
    const challenge = await consumeChallenge(c, "login");
    if (!challenge) return c.json({ error: "invalid_challenge" }, 400);
    const response = await c.req.json<AuthenticationResponseJSON>();
    if (typeof response?.id !== "string") return c.json({ error: "invalid_passkey" }, 400);
    const credential = await c.env.DB.prepare("SELECT id, user_id, public_key, counter FROM passkeys WHERE id = ?").bind(response.id)
      .first<{ id: string; user_id: string; public_key: ArrayBuffer; counter: number }>();
    if (!credential) return c.json({ error: "invalid_passkey" }, 400);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge,
        expectedOrigin: c.env.PORTAL_ORIGIN, expectedRPID: c.env.RP_ID, requireUserVerification: true,
        credential: { id: credential.id, publicKey: new Uint8Array(credential.public_key), counter: credential.counter } });
    } catch { return c.json({ error: "invalid_passkey" }, 400); }
    if (!verification.verified) return c.json({ error: "invalid_passkey" }, 400);
    // CAS prevents concurrent assertions from moving the counter backwards.
    const updated = await c.env.DB.prepare("UPDATE passkeys SET counter = ? WHERE id = ? AND counter = ?")
      .bind(verification.authenticationInfo.newCounter, credential.id, credential.counter).run();
    if (!updated.meta.changes) return c.json({ error: "invalid_passkey" }, 400);
    const user = await userById(c, credential.user_id);
    if (!user) return c.json({ error: "invalid_passkey" }, 400);
    await createSession(c, user);
    await audit(c, "auth.login.passkey", user.id);
    return c.json({ ok: true });
  });
}
