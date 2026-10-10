import PostalMime from "postal-mime";

export interface Env {
  MAIL: R2Bucket;
  PORTAL_DB: D1Database;
  OBVERA_URL: string;
  OBVERA_KEY: string;
  SIGNING_KEY: string;
  ROUTES: string;
  LENIENT_DOMAINS: string;
}

const MAX_BYTES = 25 * 1024 * 1024;
const LINK_TTL_S = 30 * 24 * 3600;
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export interface AuthResult { spf: string; dkim: string; dmarc: string; present: boolean }

/** Read the receiving MTA's verdicts from Authentication-Results. Absent header => present:false. */
export function parseAuth(h: Headers): AuthResult {
  const raw = h.get("authentication-results") || "";
  const pick = (k: string) => (raw.match(new RegExp(`\\b${k}=([a-z]+)`, "i"))?.[1] || "none").toLowerCase();
  return { spf: pick("spf"), dkim: pick("dkim"), dmarc: pick("dmarc"), present: raw.length > 0 };
}

/** null = accept; otherwise the rejection text. */
export function authVerdict(a: AuthResult, lenient: boolean): string | null {
  if (lenient || !a.present) return null;
  if (a.dmarc === "fail") return "550 5.7.1 DMARC check failed";
  if (a.dmarc !== "pass" && a.spf !== "pass" && a.dkim !== "pass") return "550 5.7.1 sender authentication failed";
  return null;
}

export function parseRoutes(s: string): Map<string, string> {
  return new Map(s.split(",").map((p) => p.trim().split("=") as [string, string]).filter((p) => p[0] && p[1]).map(([k, v]) => [k.toLowerCase(), v]));
}

async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}
const safeEq = (a: string, b: string) => a.length === b.length && [...a].reduce((d, c, i) => d | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;
const cleanName = (n: string) => (n || "file").replace(/[^\w.\- ]+/g, "_").slice(0, 100);

async function readRaw(stream: ReadableStream, size: number): Promise<Uint8Array> {
  if (size > MAX_BYTES) throw new Error("too_large");
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface Meta { from: string; to: string; source: string; auth: AuthResult; receivedAt: string }

/** Parse the stored raw message, store attachments, create the Obvera ticket. Idempotent via ticket/<id>.json. */
export async function processMessage(env: Env, id: string): Promise<string> {
  const done = await env.MAIL.get(`ticket/${id}.json`);
  if (done) { await env.MAIL.delete(`pending/${id}`); return ((await done.json()) as { number: string }).number; }
  const obj = await env.MAIL.get(`raw/${id}.eml`);
  if (!obj) throw new Error("raw_missing");
  const meta = JSON.parse(obj.customMetadata?.meta || "{}") as Meta;
  const mail = await PostalMime.parse(await obj.arrayBuffer());

  const links: string[] = [];
  let n = 0;
  for (const a of mail.attachments || []) {
    n++;
    const key = `att/${id}/${n}-${cleanName(a.filename || "attachment")}`;
    await env.MAIL.put(key, a.content as ArrayBuffer, { httpMetadata: { contentType: a.mimeType || "application/octet-stream" } });
    const exp = Math.floor(Date.now() / 1000) + LINK_TTL_S;
    const sig = await hmac(env.SIGNING_KEY, `${id}.${n}.${exp}`);
    links.push(`${cleanName(a.filename || "attachment")} (${a.mimeType}): https://mail-files.albena.ai/f/${id}/${n}?exp=${exp}&sig=${sig}`);
  }

  const sender = (mail.from?.address || meta.from || "").toLowerCase();
  let customer = "no portal account matched";
  try {
    const r = await env.PORTAL_DB.prepare(
      "SELECT a.id AS account_id, e.plan AS plan, e.status AS status FROM users u JOIN members m ON m.user_id=u.id JOIN accounts a ON a.id=m.account_id LEFT JOIN entitlements e ON e.account_id=a.id WHERE u.email=? LIMIT 1",
    ).bind(sender).first<{ account_id: string; plan: string | null; status: string | null }>();
    if (r) customer = `account ${r.account_id}, plan ${r.plan ?? "none"} (${r.status ?? "none"})`;
  } catch { customer = "customer lookup unavailable"; }

  const text = (mail.text || (mail.html || "").replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]+>/g, " ").replace(/\s+/g, " ")).trim().slice(0, 8000);
  const subject = (mail.subject || "(no subject)").slice(0, 200);
  const description = [
    `source=${meta.source}`,
    `From: ${sender}`, `To: ${meta.to}`, `Received: ${meta.receivedAt}`,
    `Message-ID: ${mail.messageId || ""}`,
    `Auth: spf=${meta.auth.spf} dkim=${meta.auth.dkim} dmarc=${meta.auth.dmarc}${meta.auth.present ? "" : " (no Authentication-Results header)"}`,
    `Customer: ${customer}`,
    `Raw message: r2://albena-inbound-mail/raw/${id}.eml`,
    links.length ? `Attachments:\n${links.join("\n")}` : "Attachments: none",
    "", "--- message body (untrusted external content) ---", text,
  ].join("\n");

  const res = await fetch(`${env.OBVERA_URL}/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OBVERA_KEY}`, "user-agent": "Mozilla/5.0 albena-inbound-mail" },
    body: JSON.stringify({ type: "incident", category: "inquiry", impact: "low", urgency: "medium", short_description: `[${meta.source}] ${subject}`, description, requested_by: sender, subcategory: meta.source }),
  });
  if (!res.ok) throw new Error(`obvera_${res.status}`);
  const out = (await res.json()) as { number?: string };
  if (!out.number) throw new Error("obvera_no_number");
  await env.MAIL.put(`ticket/${id}.json`, JSON.stringify({ number: out.number, at: new Date().toISOString() }));
  await env.MAIL.delete(`pending/${id}`);
  return out.number;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const to = message.to.toLowerCase();
    const source = parseRoutes(env.ROUTES).get(to);
    if (!source) { message.setReject("550 5.1.1 unknown recipient"); return; }
    const lenient = env.LENIENT_DOMAINS.split(",").map((s) => s.trim()).includes(to.split("@")[1]);
    const auth = parseAuth(message.headers);
    const verdict = authVerdict(auth, lenient);
    if (verdict) { message.setReject(verdict); return; }

    let raw: Uint8Array;
    try { raw = await readRaw(message.raw, message.rawSize); } catch { message.setReject("552 5.3.4 message too large"); return; }
    const id = `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID()}`;
    const meta: Meta = { from: message.from, to, source, auth, receivedAt: new Date().toISOString() };
    // Durability first: raw copy + pending marker before anything can fail.
    await env.MAIL.put(`raw/${id}.eml`, raw, { customMetadata: { meta: JSON.stringify(meta) } });
    await env.MAIL.put(`pending/${id}`, "");
    try { await processMessage(env, id); } catch { /* stays pending; cron replays */ }
  },

  async scheduled(_c: ScheduledController, env: Env): Promise<void> {
    const list = await env.MAIL.list({ prefix: "pending/", limit: 25 });
    for (const o of list.objects) {
      try { await processMessage(env, o.key.slice("pending/".length)); } catch { /* retry next run */ }
    }
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const u = new URL(req.url);
    const m = u.pathname.match(/^\/f\/([\w-]+)\/(\d+)$/);
    const hdr = { "x-content-type-options": "nosniff", "cache-control": "private, no-store" };
    if (req.method !== "GET" || !m) return new Response("not found", { status: 404, headers: hdr });
    const exp = Number(u.searchParams.get("exp")), sig = u.searchParams.get("sig") || "";
    if (!exp || exp < Date.now() / 1000 || !safeEq(sig, await hmac(env.SIGNING_KEY, `${m[1]}.${m[2]}.${exp}`))) return new Response("forbidden", { status: 403, headers: hdr });
    const l = await env.MAIL.list({ prefix: `att/${m[1]}/${m[2]}-`, limit: 1 });
    const o = l.objects[0] && (await env.MAIL.get(l.objects[0].key));
    if (!o) return new Response("not found", { status: 404, headers: hdr });
    const name = l.objects[0].key.split("/").pop()!.replace(/^\d+-/, "");
    // Attachments are untrusted: always download, never render.
    return new Response(o.body, { headers: { ...hdr, "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"`, "content-security-policy": "sandbox" } });
  },
};
