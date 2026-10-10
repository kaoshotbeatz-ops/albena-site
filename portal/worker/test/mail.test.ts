import { describe, expect, it, vi } from "vitest";
import { composeHousehold, composeInvite, composeSignIn, SENDER_IDENTITY } from "../src/auth/compose";
import { cloudflareMailer } from "../src/auth/mail";
import { e } from "./helpers";

const URL1 = "https://account.albena.ai/api/auth/magic/verify?token=a.b&x=1";
const all = [composeSignIn(URL1, "123456"), composeInvite(URL1), composeHousehold("o@example.com", "k@example.com", URL1)];
const urls = (s: string) => [...new Set(s.match(/https?:\/\/[^\s"<]+/g) ?? [])].map((u) => u.replace(/&amp;/g, "&"));

describe("mail composition", () => {
  it.each(all.map((m) => [m.subject, m] as const))("%s: html + text, identical links, no trackers, hygiene", (_s, m) => {
    expect(m.text.length).toBeGreaterThan(50); expect(m.html).toContain("<!doctype html>");
    const hrefs = [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1].replace(/&amp;/g, "&"));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(h).toBe(URL1);
    expect(urls(m.html)).toEqual(urls(m.text));
    expect(m.html).not.toMatch(/<img|<script|<link|url\(|bit\.ly|tinyurl|utm_/i);
    expect(m.text + m.html).not.toMatch(/utm_|bit\.ly|tinyurl/i);
    expect(m.subject).not.toMatch(/[A-Z]{4,}|!|\p{Extended_Pictographic}/u); expect(m.subject).not.toMatch(/free|urgent|act now/i);
    expect(m.text).toContain(SENDER_IDENTITY); expect(m.html).toContain("Omar Huertas LLC");
    expect(m.text).toMatch(/Didn't (request|expect)/); expect(m.text).toMatch(/expire/);
  });
  it("invite says who invited and why", () => {
    const m = composeInvite(URL1); expect(m.subject).toBe("You're invited to the Albena pilot"); expect(m.html).toContain("Albena invited you to the pilot");
  });
  it("html-escapes interpolated values", () => {
    expect(composeHousehold("<b>x</b>@e.com", "k@e.com", URL1).html).not.toContain("<b>x");
  });
  it("sends multipart with From, Reply-To and no List-Unsubscribe", async () => {
    const send = vi.fn(); const mailer = cloudflareMailer({ ...e, MAIL_FROM: "accounts@albena.ai", EMAIL: { send } as never });
    await mailer.send({ to: "a@example.com", url: URL1, code: "123456" });
    await mailer.notice({ to: "a@example.com", ...composeInvite(URL1) });
    for (const [msg] of send.mock.calls) {
      expect(msg.from).toEqual({ email: "accounts@albena.ai", name: "Albena" });
      expect(msg.replyTo).toBe("accounts@albena.ai"); expect(msg.text).toBeTruthy(); expect(msg.html).toBeTruthy();
      expect(JSON.stringify(msg.headers ?? {})).not.toMatch(/unsubscribe/i);
    }
  });
});
