/** Pure composition of transactional emails: multipart text + inline-CSS HTML. No remote images, no trackers; every link is shown as plain text and used verbatim as the href. */
export interface Composed { subject: string; text: string; html: string }

/** Mailing identity (CAN-SPAM friendly). TODO(Omar): replace the placeholder city/state/ZIP with the real mailing address. */
export const SENDER_IDENTITY = "Omar Huertas LLC, [City, ST ZIP]";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface Parts { preheader: string; heading: string; lines: string[]; code?: string; button?: { label: string; url: string }; fine: string[] }

function render(p: Parts): string {
  const para = (t: string) => `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#222222;">${esc(t)}</p>`;
  const code = p.code ? `<p style="margin:0 0 20px;font-size:28px;line-height:36px;letter-spacing:4px;font-family:Menlo,Consolas,monospace;color:#111111;"><strong>${esc(p.code)}</strong></p>` : "";
  const btn = p.button ? `<p style="margin:0 0 16px;"><a href="${esc(p.button.url)}" style="display:inline-block;background:#1a3a5c;color:#ffffff;text-decoration:none;font-size:16px;font-weight:bold;padding:12px 24px;border-radius:6px;">${esc(p.button.label)}</a></p>
<p style="margin:0 0 24px;font-size:14px;line-height:20px;color:#444444;">Or paste this link into your browser:<br><a href="${esc(p.button.url)}" style="color:#1a3a5c;word-break:break-all;">${esc(p.button.url)}</a></p>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(p.heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f6;">
<div style="display:none;max-height:0;overflow:hidden;color:#f4f4f6;">${esc(p.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
<tr><td style="padding:24px 32px 0;font-size:22px;font-weight:bold;color:#1a3a5c;">Albena</td></tr>
<tr><td style="padding:16px 32px 8px;">
<h1 style="margin:0 0 16px;font-size:20px;line-height:28px;color:#111111;">${esc(p.heading)}</h1>
${p.lines.map(para).join("\n")}${code}${btn}${p.fine.map((t) => `<p style="margin:0 0 12px;font-size:13px;line-height:19px;color:#555555;">${esc(t)}</p>`).join("\n")}
</td></tr>
<tr><td style="padding:8px 32px 24px;font-size:12px;line-height:18px;color:#666666;border-top:1px solid #eeeeee;">Sent by Albena, a service of ${esc(SENDER_IDENTITY)}. This is a one-off account email, not a newsletter.</td></tr>
</table></td></tr></table></body></html>`;
}

function renderText(p: Parts): string {
  const out = [p.heading, "", ...p.lines.flatMap((l) => [l, ""])];
  if (p.code) out.push(`Your code: ${p.code}`, "");
  if (p.button) out.push(`${p.button.label}: ${p.button.url}`, "");
  out.push(...p.fine.flatMap((l) => [l, ""]), `Sent by Albena, a service of ${SENDER_IDENTITY}.`);
  return out.join("\n");
}

const build = (subject: string, p: Parts): Composed => ({ subject, text: renderText(p), html: render(p) });

export function composeSignIn(url: string, code: string): Composed {
  return build("Sign in to Albena", {
    preheader: "Your Albena sign-in code and link. Expires in 15 minutes.",
    heading: "Sign in to Albena",
    lines: ["Use this code or the button below to sign in. If you opened this email on another device, enter the code on the page where you requested it."],
    code: `${code.slice(0, 3)} ${code.slice(3)}`,
    button: { label: "Sign in", url },
    fine: ["The code and link expire in 15 minutes and work once.", "Didn't request this? You can ignore this email. Nobody can sign in without the code or link."],
  });
}

export function composeInvite(url: string, opts: { days?: number } = {}): Composed {
  return build("You're invited to the Albena pilot", {
    preheader: "Albena invited you to the pilot. Set up your account.",
    heading: "Albena invited you to the pilot",
    lines: ["The Albena team invited you to try Albena, a private home assistant. Use the button below to set up your account.", "You will be asked to confirm this email address, then we send a normal sign-in email to it."],
    button: { label: "Set up my account", url },
    fine: [`The link works once and expires in ${opts.days ?? 14} days.`, "Didn't expect this invitation? You can ignore this email and nothing will happen."],
  });
}

export function composeHousehold(inviterEmail: string, email: string, loginUrl: string): Composed {
  return build("You're invited to an Albena household", {
    preheader: `${inviterEmail} invited you to join their Albena household.`,
    heading: `${inviterEmail} invited you to their Albena household`,
    lines: [`${inviterEmail} invited you to join their Albena household. Sign in with this email address (${email}) and you will be added to their account.`],
    button: { label: "Sign in to join", url: loginUrl },
    fine: ["The invitation expires in 14 days.", "Didn't expect this? You can ignore this email."],
  });
}
