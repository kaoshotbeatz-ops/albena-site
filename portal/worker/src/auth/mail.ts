import { EmailMessage } from "cloudflare:email";
import type { Bindings } from "../types";

export interface Mail { to: string; url: string }
/** Delivery adapter: credentials and the magic URL must never enter logs. */
export async function sendMail(env: Bindings, mail: Mail): Promise<void> {
  if (env.MAIL_PROVIDER === "dev" && env.ENVIRONMENT !== "production") {
    console.info("[portal mail] magic-link delivery requested (recipient and token redacted)");
    return;
  }
  const text = `Sign in to Albena: ${mail.url}\nThis link expires in 15 minutes. Open it in the browser that requested it. If you did not request it, ignore this email.`;
  if (env.MAIL_PROVIDER === "cloudflare" && env.EMAIL) {
    const raw = `From: ${env.MAIL_FROM}\r\nTo: ${mail.to}\r\nSubject: Sign in to Albena\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`;
    await env.EMAIL.send(new EmailMessage(env.MAIL_FROM, mail.to, raw));
    return;
  }
  if (env.MAIL_PROVIDER === "mailchannels" && env.MAILCHANNELS_API_KEY) {
    const response = await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": env.MAILCHANNELS_API_KEY },
      body: JSON.stringify({ personalizations: [{ to: [{ email: mail.to }] }], from: { email: env.MAIL_FROM, name: "Albena" }, subject: "Sign in to Albena", content: [{ type: "text/plain", value: text }] }),
    });
    if (!response.ok) throw new Error("mail_delivery_failed");
    return;
  }
  throw new Error("mail_not_configured");
}
