import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/types";
import { randomToken, sha256, equalHash } from "../src/auth/crypto";
import { SESSION_COOKIE, now, IDLE_SECONDS, ABSOLUTE_SECONDS } from "../src/auth/sessions";
import { verifyChain, sealAudit } from "../src/auditchain";
// The Cloudflare pool pre-loads the worker entry, so static imports would bypass vi.mock.
// Re-import the app (and the mocked modules) after resetModules so the mocks apply.
let app: typeof import("../src/index")["app"];
let sendMail: typeof import("../src/auth/mail")["sendMail"];
let generateAuthenticationOptions: typeof import("@simplewebauthn/server")["generateAuthenticationOptions"];
let generateRegistrationOptions: typeof import("@simplewebauthn/server")["generateRegistrationOptions"];
let verifyAuthenticationResponse: typeof import("@simplewebauthn/server")["verifyAuthenticationResponse"];
let verifyRegistrationResponse: typeof import("@simplewebauthn/server")["verifyRegistrationResponse"];

vi.mock("../src/auth/mail", () => ({ sendMail: vi.fn() }));
vi.mock("@simplewebauthn/server", () => ({
  generateAuthenticationOptions: vi.fn(), generateRegistrationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(), verifyRegistrationResponse: vi.fn(),
}));
const e = env as unknown as Bindings;
const origin = "https://account.albena.ai";
let bindings: Bindings;
const limiter = () => ({ limit: vi.fn(async () => ({ success: true })) });
function request(path: string, method = "GET", body?: unknown, cookie?: string, headers: Record<string, string> = {}) {
  return app.request(origin + path, { method, headers: { "X-Requested-With": "albena-portal", Origin: origin, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, bindings);
}
function cookie(response: Response, name: string): string {
  const value = response.headers.getSetCookie().find(c => c.startsWith(name + "="));
  expect(value).toBeDefined();
  return value!.split(";")[0];
}
async function seedUser() {
  const id = crypto.randomUUID(), email = `${id}@example.com`;
  await e.DB.batch([
    e.DB.prepare("INSERT INTO users (id,email) VALUES (?,?)").bind(id, email),
    e.DB.prepare("INSERT INTO accounts (id,owner) VALUES (?,?)").bind(id,id),
    e.DB.prepare("INSERT INTO members (account_id,user_id,role) VALUES (?,?,'owner')").bind(id,id),
  ]);
  return { id, email };
}
async function session(user?: { id: string; email: string }) {
  const u = user ?? await seedUser(), token = randomToken(), id = crypto.randomUUID(), ts = now();
  await e.DB.prepare("INSERT INTO sessions (id,token_hash,user_id,account_id,created_at,last_seen,expires_at) VALUES (?,?,?,?,?,?,?)")
    .bind(id, await sha256(token), u.id, u.id, ts, ts, ts + ABSOLUTE_SECONDS).run();
  return { ...u, sessionId: id, token, cookie: `${SESSION_COOKIE}=${token}` };
}
async function magic(email = `${crypto.randomUUID()}@example.com`) {
  const result = await request("/api/auth/magic/start", "POST", { email, turnstileToken: "test-response" });
  expect(result.status).toBe(202);
  const mail = vi.mocked(sendMail).mock.calls.at(-1)![1];
  return { path: new URL(mail.url).pathname + new URL(mail.url).search, code: mail.code, cookie: cookie(result, "__Host-albena_magic"), email };
}
async function loginChallenge() {
  const result = await request("/api/auth/passkey/login/options", "POST");
  expect(result.status).toBe(200);
  return cookie(result, "__Host-albena_passkey");
}
beforeEach(async () => {
  vi.resetModules();
  ({ app } = await import("../src/index"));
  ({ sendMail } = await import("../src/auth/mail"));
  ({ generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } = await import("@simplewebauthn/server"));
  vi.resetAllMocks();
  bindings = { ...e, AUTH_IP_LIMITER: limiter(), AUTH_EMAIL_LIMITER: limiter() };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, hostname: "account.albena.ai", action: "magic_login" })));
  vi.mocked(sendMail).mockResolvedValue(undefined);
  vi.mocked(generateAuthenticationOptions).mockResolvedValue({ challenge: randomToken(), rpId: "albena.ai", userVerification: "required" });
  vi.mocked(generateRegistrationOptions).mockResolvedValue({ challenge: randomToken(), rp: { id: "albena.ai", name: "Albena" }, user: { id: "id", name: "name", displayName: "name" }, pubKeyCredParams: [] });
});

afterEach(() => vi.unstubAllGlobals());

describe("magic links", () => {
  it("returns identical responses for new and existing emails, creates users only after verification", async () => {
    const u = await seedUser(), fresh = `${crypto.randomUUID()}@example.com`;
    const start = (email: string) => request("/api/auth/magic/start", "POST", { email, turnstileToken: "test" });
    const a = await start(u.email), b = await start(fresh);
    expect(a.status).toBe(202); expect(b.status).toBe(202);
    expect(await a.json()).toEqual(await b.json());
    expect(await e.DB.prepare("SELECT id FROM users WHERE email=?").bind(fresh).first()).toBeNull();
  });
  it("stores hashes, logs in once, creates an account and rejects replay", async () => {
    const m = await magic(), token = new URL(origin + m.path).searchParams.get("token")!;
    const [id, secret] = token.split(".");
    const row = await e.DB.prepare("SELECT token_hash FROM magic_tokens WHERE id=?").bind(id).first<{ token_hash: string }>();
    expect(row?.token_hash).toBe(await sha256(secret)); expect(row?.token_hash).not.toBe(secret);
    const result = await request(m.path, "GET", undefined, m.cookie);
    expect(result.status).toBe(303);
    const sessionCookie = cookie(result, SESSION_COOKIE);
    expect(result.headers.getSetCookie().join(" ")).toContain("HttpOnly");
    expect(result.headers.getSetCookie().join(" ")).toContain("Secure");
    expect(result.headers.getSetCookie().join(" ")).toContain("SameSite=Lax");
    expect(result.headers.getSetCookie().join(" ")).not.toContain("Domain=");
    const me = await request("/api/me", "GET", undefined, sessionCookie);
    expect(me.status).toBe(200);
    expect((await me.json() as { user: { role: string } }).user.role).toBe("owner");
    expect((await request(m.path, "GET", undefined, m.cookie)).status).toBe(400);
  });
  it("allows only one concurrent redemption", async () => {
    const m = await magic();
    const results = await Promise.all([request(m.path,"GET",undefined,m.cookie), request(m.path,"GET",undefined,m.cookie)]);
    expect(results.map(r => r.status).sort()).toEqual([303,400]);
  });
  it("rejects expiry at the exact boundary", async () => {
    const m = await magic();
    await e.DB.prepare("UPDATE magic_tokens SET expires_at=? WHERE email=?").bind(now(),m.email).run();
    expect((await request(m.path,"GET",undefined,m.cookie)).status).toBe(400);
  });
  it("requires the initiating browser and rejects tampering without consuming a valid token", async () => {
    const m = await magic();
    expect((await request(m.path)).status).toBe(400);
    const changed = m.path.slice(0,-1) + (m.path.endsWith("a") ? "b" : "a");
    expect((await request(changed,"GET",undefined,m.cookie)).status).toBe(400);
    expect((await request(m.path,"GET",undefined,m.cookie)).status).toBe(303);
  });
  it("rotates and invalidates the old login session", async () => {
    const s = await session(), m = await magic(s.email);
    const result = await request(m.path,"GET",undefined,`${m.cookie}; ${s.cookie}`);
    expect(result.status).toBe(303); expect(cookie(result, SESSION_COOKIE)).not.toBe(s.cookie);
    expect((await request("/api/me","GET",undefined,s.cookie)).status).toBe(401);
  });
  it.each([{ success: false }, { success: true, hostname: "evil.example", action: "magic_login" }, { success: true, hostname: "account.albena.ai", action: "other" }])("rejects invalid Turnstile result %j", async result => {
    vi.mocked(fetch).mockResolvedValue(Response.json(result));
    expect((await request("/api/auth/magic/start","POST",{ email:"a@example.com",turnstileToken:"test" })).status).toBe(400);
    expect(sendMail).not.toHaveBeenCalled();
  });
  it("rate limits independently by IP and normalized email without exposing the address", async () => {
    vi.mocked(bindings.AUTH_EMAIL_LIMITER.limit).mockResolvedValue({ success: false });
    const r = await request("/api/auth/magic/start","POST",{ email:"  A@Example.com  ",turnstileToken:"test" });
    expect(r.status).toBe(202); expect(sendMail).not.toHaveBeenCalled();
    expect(bindings.AUTH_IP_LIMITER.limit).toHaveBeenCalled();
    expect(bindings.AUTH_EMAIL_LIMITER.limit).toHaveBeenCalledWith({ key: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it("conceals delivery failure and invalidates the undelivered token", async () => {
    vi.mocked(sendMail).mockRejectedValue(new Error("provider failure"));
    const email = `${crypto.randomUUID()}@example.com`;
    const r = await request("/api/auth/magic/start","POST",{ email,turnstileToken:"test" });
    expect(r.status).toBe(202);
    expect(await e.DB.prepare("SELECT id FROM magic_tokens WHERE email=?").bind(email).first()).toBeNull();
  });
  it("compares fixed-size hashes and rejects mismatches", () => {
    expect(equalHash("a".repeat(64),"a".repeat(64))).toBe(true);
    expect(equalHash("a".repeat(64),"b".repeat(64))).toBe(false);
    expect(equalHash("a","a")).toBe(false);
  });
});

describe("magic email code", () => {
  const post = (code: string, cookieHeader?: string) => request("/api/auth/magic/code", "POST", { code }, cookieHeader);
  const wrong = (c: string) => (c === "000000" ? "111111" : "000000");
  it("signs in with the correct code, then rejects reuse", async () => {
    const m = await magic(), row0 = await e.DB.prepare("SELECT code_hash FROM magic_tokens WHERE email=?").bind(m.email).first<{ code_hash: string }>();
    expect(row0?.code_hash).toMatch(/^[a-f0-9]{64}$/); expect(row0?.code_hash).not.toContain(m.code);
    expect(m.code).toMatch(/^\d{6}$/);
    const r = await post(m.code, m.cookie);
    expect(r.status).toBe(200);
    const me = await request("/api/me", "GET", undefined, cookie(r, SESSION_COOKIE));
    expect(me.status).toBe(200);
    expect(await e.DB.prepare("SELECT id FROM magic_tokens WHERE email=?").bind(m.email).first()).toBeNull();
    expect((await post(m.code, m.cookie)).status).toBe(400);
    expect((await request(m.path, "GET", undefined, m.cookie)).status).toBe(400);
    const hist = await request("/api/security/history", "GET", undefined, cookie(r, SESSION_COOKIE));
    expect(((await hist.json()) as { events: { method: string }[] }).events[0].method).toBe("magic_link");
  });
  it("accepts spaced input as pasted from the email", async () => {
    const m = await magic();
    expect((await post(`${m.code.slice(0, 3)} ${m.code.slice(3)}`, m.cookie)).status).toBe(200);
  });
  it("counts wrong attempts, locks on the 5th and rejects the right code afterwards", async () => {
    const m = await magic(), bad = wrong(m.code);
    for (let i = 1; i <= 4; i++) {
      const r = await post(bad, m.cookie);
      expect(r.status).toBe(400); expect(await r.json()).toMatchObject({ error: "wrong_code", attemptsLeft: 5 - i });
    }
    const row = await e.DB.prepare("SELECT attempts FROM magic_tokens WHERE email=?").bind(m.email).first<{ attempts: number }>();
    expect(row?.attempts).toBe(4);
    expect(await (await post(bad, m.cookie)).json()).toMatchObject({ error: "too_many_attempts" });
    const sixth = await post(m.code, m.cookie);
    expect(sixth.status).toBe(400); expect(sixth.headers.getSetCookie().join(" ")).not.toContain(SESSION_COOKIE);
    expect((await request(m.path, "GET", undefined, m.cookie)).status).toBe(400);
  });
  it("is useless without the browser-binding cookie", async () => {
    const m = await magic();
    expect((await post(m.code)).status).toBe(400);
    expect((await post(m.code, `__Host-albena_magic=${"a".repeat(64)}`)).status).toBe(400);
    expect((await post(m.code, m.cookie)).status).toBe(200);
  });
  it("rejects an expired code and malformed input", async () => {
    const m = await magic();
    expect((await post("12345", m.cookie)).status).toBe(400);
    expect(await e.DB.prepare("SELECT attempts FROM magic_tokens WHERE email=?").bind(m.email).first<{ attempts: number }>()).toEqual({ attempts: 0 });
    await e.DB.prepare("UPDATE magic_tokens SET expires_at=? WHERE email=?").bind(now(), m.email).run();
    expect(await (await post(m.code, m.cookie)).json()).toMatchObject({ error: "invalid_or_expired_code" });
  });
  it("is rate limited", async () => {
    vi.mocked(bindings.AUTH_IP_LIMITER.limit).mockResolvedValue({ success: false });
    expect((await post("123456", "")).status).toBe(429);
  });
  it("never puts the code in the subject and keeps start responses enumeration-safe", async () => {
    const u = await seedUser(), a = await request("/api/auth/magic/start", "POST", { email: u.email, turnstileToken: "t" }),
      b = await request("/api/auth/magic/start", "POST", { email: `${crypto.randomUUID()}@example.com`, turnstileToken: "t" });
    expect(await a.json()).toEqual(await b.json());
    const { cloudflareMailer } = await vi.importActual<typeof import("../src/auth/mail")>("../src/auth/mail");
    const send = vi.fn(); await cloudflareMailer({ ...e, EMAIL: { send } as never }).send({ to: "a@example.com", url: "https://x/y", code: "123456" });
    const msg = send.mock.calls[0][0];
    expect(msg.subject).not.toMatch(/\d{3}/); expect(msg.text).toContain("Your code: 123 456"); expect(msg.text).toContain("https://x/y");
    expect(msg.text).toContain("enter the code on the page where you requested it");
  });
});

describe("sessions and CSRF", () => {
  it("lists nonsecret ids and revokes only owned sessions", async () => {
    const a = await session(), b = await session();
    const r = await request("/api/security/sessions","GET",undefined,a.cookie);
    const text = await r.text(); expect(text).toContain(a.sessionId); expect(text).not.toContain(a.token); expect(text).not.toContain("token_hash");
    expect((await request(`/api/security/sessions/${b.sessionId}`,"DELETE",undefined,a.cookie)).status).toBe(404);
    expect((await request(`/api/security/sessions/${a.sessionId}`,"DELETE",undefined,a.cookie)).status).toBe(200);
    expect((await request("/api/me","GET",undefined,a.cookie)).status).toBe(401);
    expect((await request("/api/me","GET",undefined,b.cookie)).status).toBe(200);
  });
  it("logout revokes the current session", async () => {
    const s = await session();
    expect((await request("/api/auth/logout","POST",undefined,s.cookie)).status).toBe(200);
    expect((await request("/api/me","GET",undefined,s.cookie)).status).toBe(401);
  });
  it.each(["idle","absolute"])("enforces %s timeout", async kind => {
    const s = await session();
    await e.DB.prepare(kind === "idle" ? "UPDATE sessions SET last_seen=? WHERE id=?" : "UPDATE sessions SET expires_at=? WHERE id=?")
      .bind(kind === "idle" ? now()-IDLE_SECONDS : now(),s.sessionId).run();
    expect((await request("/api/me","GET",undefined,s.cookie)).status).toBe(401);
  });
  it("refreshes idle time without extending absolute expiry", async () => {
    const s = await session();
    await e.DB.prepare("UPDATE sessions SET last_seen=? WHERE id=?").bind(now()-100,s.sessionId).run();
    const before = await e.DB.prepare("SELECT expires_at FROM sessions WHERE id=?").bind(s.sessionId).first();
    expect((await request("/api/me","GET",undefined,s.cookie)).status).toBe(200);
    const after = await e.DB.prepare("SELECT expires_at,last_seen FROM sessions WHERE id=?").bind(s.sessionId).first<{ expires_at: number; last_seen: number }>();
    expect(after?.expires_at).toBe(before?.expires_at); expect(after?.last_seen).toBeGreaterThanOrEqual(now()-1);
  });
  it.each<Record<string, string>>([{ "X-Requested-With": "" }, { Origin: "https://evil.example" }, { "Sec-Fetch-Site": "cross-site" }])("rejects unsafe writes %j", async headers => {
    const s = await session();
    expect((await request("/api/auth/logout","POST",undefined,s.cookie,headers)).status).toBe(403);
    expect((await request("/api/me","GET",undefined,s.cookie)).status).toBe(200);
  });
});

describe("passkeys", () => {
  it("requires login to register", async () => {
    expect((await request("/api/auth/passkey/register/options","POST")).status).toBe(401);
  });
  it("uses discoverable credentials without email enumeration", async () => {
    const result = await request("/api/auth/passkey/login/options","POST");
    expect(result.status).toBe(200);
    expect(generateAuthenticationOptions).toHaveBeenCalledWith({ rpID:"albena.ai",userVerification:"required" });
    expect(await result.text()).not.toContain("allowCredentials");
  });
  it("stores the public key and counter and rejects registration challenge reuse", async () => {
    const s = await session();
    const options = await request("/api/auth/passkey/register/options","POST",undefined,s.cookie);
    const jar = `${s.cookie}; ${cookie(options,"__Host-albena_passkey")}`;
    const id = randomToken();
    vi.mocked(verifyRegistrationResponse).mockResolvedValue({ verified:true, registrationInfo: { credential: { id, publicKey:new Uint8Array([1,2,3]),counter:0 } } } as Awaited<ReturnType<typeof verifyRegistrationResponse>>);
    expect((await request("/api/auth/passkey/register/verify","POST",{},jar)).status).toBe(200);
    expect((await request("/api/auth/passkey/register/verify","POST",{},jar)).status).toBe(400);
    expect(verifyRegistrationResponse).toHaveBeenCalledTimes(1);
    expect(verifyRegistrationResponse).toHaveBeenCalledWith(expect.objectContaining({ expectedOrigin:origin,expectedRPID:"albena.ai",requireUserVerification:true }));
    expect(await e.DB.prepare("SELECT counter FROM passkeys WHERE id=?").bind(id).first()).toEqual({ counter:0 });
  });
  it("binds registration challenges to the authenticated session", async () => {
    const a = await session(), b = await session(a);
    const options = await request("/api/auth/passkey/register/options","POST",undefined,a.cookie);
    const jar = `${b.cookie}; ${cookie(options,"__Host-albena_passkey")}`;
    expect((await request("/api/auth/passkey/register/verify","POST",{},jar)).status).toBe(400);
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
  });
  it("logs in with a verified assertion and rejects challenge replay before calling verifier", async () => {
    const s = await session(), id = randomToken();
    await e.DB.prepare("INSERT INTO passkeys (id,user_id,public_key,counter) VALUES (?,?,?,?)").bind(id,s.id,new Uint8Array([1,2,3]),1).run();
    const jar = await loginChallenge();
    vi.mocked(verifyAuthenticationResponse).mockResolvedValue({ verified:true,authenticationInfo:{ newCounter:2 } } as Awaited<ReturnType<typeof verifyAuthenticationResponse>>);
    const r = await request("/api/auth/passkey/login/verify","POST",{ id },jar);
    expect(r.status).toBe(200); cookie(r,SESSION_COOKIE);
    expect((await request("/api/auth/passkey/login/verify","POST",{ id },jar)).status).toBe(400);
    expect(verifyAuthenticationResponse).toHaveBeenCalledTimes(1);
    expect(verifyAuthenticationResponse).toHaveBeenCalledWith(expect.objectContaining({ expectedOrigin:origin,expectedRPID:"albena.ai",requireUserVerification:true }));
    expect(await e.DB.prepare("SELECT counter FROM passkeys WHERE id=?").bind(id).first()).toEqual({ counter:2 });
  });
  it.each(["throw", "unverified"])("rejects %s verification without issuing a session", async mode => {
    const s = await session(), id = randomToken();
    await e.DB.prepare("INSERT INTO passkeys (id,user_id,public_key,counter) VALUES (?,?,?,?)").bind(id,s.id,new Uint8Array([1,2,3]),5).run();
    const jar = await loginChallenge();
    if (mode === "throw") vi.mocked(verifyAuthenticationResponse).mockRejectedValue(new Error("invalid signature or counter"));
    else vi.mocked(verifyAuthenticationResponse).mockResolvedValue({ verified:false,authenticationInfo:{ newCounter:6 } } as Awaited<ReturnType<typeof verifyAuthenticationResponse>>);
    const r = await request("/api/auth/passkey/login/verify","POST",{ id },jar);
    expect(r.status).toBe(400);
    expect(r.headers.getSetCookie().some(c => c.startsWith(SESSION_COOKIE+"="))).toBe(false);
    expect(await e.DB.prepare("SELECT counter FROM passkeys WHERE id=?").bind(id).first()).toEqual({ counter:5 });
    expect((await request("/api/auth/passkey/login/verify","POST",{ id },jar)).status).toBe(400);
    expect(verifyAuthenticationResponse).toHaveBeenCalledTimes(1);
  });
  it("burns challenges even after invalid assertions", async () => {
    const jar = await loginChallenge();
    expect((await request("/api/auth/passkey/login/verify","POST",{ id:"unknown" },jar)).status).toBe(400);
    expect(await (await request("/api/auth/passkey/login/verify","POST",{ id:"unknown" },jar)).json()).toEqual({ error:"invalid_challenge" });
  });
  it("rejects expired and browser-mismatched challenges", async () => {
    const jar = await loginChallenge();
    const id = jar.split("=")[1].split(".")[0];
    expect((await request("/api/auth/passkey/login/verify","POST",{ id:"any" })).status).toBe(400);
    await e.DB.prepare("UPDATE auth_challenges SET expires_at=? WHERE id=?").bind(now(),id).run();
    expect((await request("/api/auth/passkey/login/verify","POST",{ id:"any" },jar)).status).toBe(400);
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });
});

describe("worker security and audit", () => {
  it("returns CSP, request id and no-store even on errors", async () => {
    const r = await request("/api/missing");
    expect(r.status).toBe(404); expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.headers.get("X-Request-ID")).toBeTruthy();
    expect(r.headers.get("Content-Security-Policy")).toContain("form-action 'self' https://checkout.stripe.com https://billing.stripe.com");
    expect(r.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(r.headers.get("Content-Security-Policy")).toContain("connect-src 'self'");
  });
  it("does not echo malformed JSON or internal exception details", async () => {
    const r = await app.request(origin+"/api/auth/magic/start",{ method:"POST",headers:{ "X-Requested-With":"albena-portal" },body:"{" },bindings);
    expect(r.status).toBe(400); expect((await r.json() as { error: string }).error).toBe("request_rejected");
    vi.mocked(bindings.AUTH_IP_LIMITER.limit).mockRejectedValue(new Error("sensitive provider detail"));
    const error = await request("/api/auth/passkey/login/options","POST");
    expect(error.status).toBe(500); expect(await error.text()).not.toContain("sensitive");
  });
  it("seals a verifiable chain and guards sealed rows against delete/rewrite", async () => {
    const s = await session();
    await request("/api/auth/logout","POST",undefined,s.cookie);
    await sealAudit(e);
    const status = await verifyChain(e); expect(status.ok).toBe(true); expect(status.unsealed).toBe(0); expect(status.sealed).toBeGreaterThan(0);
    await expect(e.DB.prepare("DELETE FROM audit_log").run()).rejects.toThrow();
    await expect(e.DB.prepare("UPDATE audit_log SET action='tampered'").run()).rejects.toThrow();
  });
});
