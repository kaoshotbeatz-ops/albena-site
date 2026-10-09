import type { Env } from "./types";

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? "unknown";
}

export function hashIp(env: Env, ip: string): Promise<string> {
  return sha256Hex(`${env.IP_SALT}:${ip}`);
}

/** Lowercase/trim; dedupe key additionally folds gmail dots and +tags. */
export function normalizeEmail(raw: string): { email: string; key: string } {
  const email = raw.normalize("NFKC").trim().toLowerCase();
  const at = email.lastIndexOf("@");
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.split("+")[0].replaceAll(".", "");
  else local = local.split("+")[0] || local;
  return { email, key: `${local}@${domain}` };
}

/** Strip control chars (keeps \n and \t when multiline). */
export function clean(s: string, multiline = false): string {
  // eslint-disable-next-line no-control-regex
  const re = multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g;
  return s.replace(re, "").trim();
}

export async function verifyTurnstile(
  env: Env,
  token: string,
  ip: string,
  expectedAction: string,
): Promise<"ok" | "failed" | "unavailable"> {
  try {
    const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
    if (ip !== "unknown") body.set("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    if (!r.ok) return "unavailable";
    const data = (await r.json()) as { success?: boolean; hostname?: string; action?: string };
    const hosts = new Set(["albena.ai", "www.albena.ai"]);
    if (env.ENVIRONMENT !== "production") {
      hosts.add("localhost");
      for (const h of (env.EXTRA_TURNSTILE_HOSTS ?? "").split(",")) if (h.trim()) hosts.add(h.trim());
    }
    return data.success === true && typeof data.hostname === "string" && hosts.has(data.hostname) &&
      data.action === expectedAction
      ? "ok"
      : "failed";
  } catch {
    return "unavailable";
  }
}

export { audit } from "./auditchain";

/** Best-effort notification; contains no user-provided content. Never throws. */
export async function notify(env: Env, subject: string, text: string): Promise<void> {
  if (!env.MAIL || !env.NOTIFY_FROM) return;
  try {
    const { EmailMessage } = await import("cloudflare:email");
    const to = "omar@dbaomarhuertasllc.com";
    const safe = (s: string) => s.replace(/[\r\n]+/g, " ");
    const raw =
      `From: Albena Site <${env.NOTIFY_FROM}>\r\nTo: ${to}\r\nSubject: ${safe(subject)}\r\n` +
      `Message-ID: <${crypto.randomUUID()}@albena.ai>\r\nMIME-Version: 1.0\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`;
    await env.MAIL.send(new EmailMessage(env.NOTIFY_FROM, to, raw));
  } catch (err) {
    console.warn("notify failed", err instanceof Error ? err.message : "unknown");
  }
}
