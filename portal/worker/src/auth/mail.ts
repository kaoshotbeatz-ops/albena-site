import type { Bindings } from "../types";

export interface Mail { to: string; url: string; code: string }
/** Delivery adapter. The magic URL and recipient must never reach production logs. */
export interface MailProvider { send(mail: Mail): Promise<void> }

const SUBJECT = "Sign in to Albena";
const body = (url: string, code: string) =>
  `Your code: ${code.slice(0, 3)} ${code.slice(3)}\n\nOr sign in with this link: ${url}\n\nThe code and link expire in 15 minutes and work once. If you opened this on another device, enter the code on the page where you requested it. If you did not request it, ignore this email.`;

/** Cloudflare Email Sending (send_email binding). The sender domain must be onboarded. */
export function cloudflareMailer(env: Bindings): MailProvider {
  return {
    async send(mail) {
      if (!env.EMAIL) throw new Error("mail_not_configured");
      await env.EMAIL.send({ to: mail.to, from: { email: env.MAIL_FROM, name: "Albena" }, subject: SUBJECT, text: body(mail.url, mail.code) });
    },
  };
}

/** Local/test logger. Prints the link only in `development` (wrangler dev); redacted in tests. Never used in production. */
export function devMailer(env: Bindings): MailProvider {
  return {
    async send(mail) {
      if (env.ENVIRONMENT === "production") throw new Error("mail_not_configured");
      console.info(env.ENVIRONMENT === "development" ? `[portal mail] sign-in link for ${mail.to}: ${mail.url} code: ${mail.code}` : "[portal mail] magic-link delivery requested (redacted)");
    },
  };
}

export function selectMailer(env: Bindings): MailProvider {
  if (env.MAIL_PROVIDER === "cloudflare") return cloudflareMailer(env);
  if (env.MAIL_PROVIDER === "dev") return devMailer(env);
  throw new Error("mail_not_configured");
}

export const sendMail = (env: Bindings, mail: Mail): Promise<void> => selectMailer(env).send(mail);
