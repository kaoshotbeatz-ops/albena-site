import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { app } from "../src/index";
import type { Bindings } from "../src/types";
import { randomToken, sha256 } from "../src/auth/crypto";
import { SESSION_COOKIE, now, ABSOLUTE_SECONDS } from "../src/auth/sessions";

export const e = env as unknown as Bindings;
export const ORIGIN = "https://account.albena.ai";
export const WEBHOOK_SECRET = "whsec_test_secret";

const limiter = () => ({ limit: vi.fn(async () => ({ success: true })) });
/** Real D1 plus test-only secrets and Stripe price ids. */
export const testBindings = (over: Partial<Bindings> = {}): Bindings => ({
  ...e, AUTH_IP_LIMITER: limiter(), AUTH_EMAIL_LIMITER: limiter(),
  STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  PRICE_BYO_MONTHLY: "price_byo_m", PRICE_BYO_ANNUAL: "price_byo_a",
  PRICE_HUB_MAC_MONTHLY: "price_mac_m", PRICE_HUB_MAC_ANNUAL: "price_mac_a", PRICE_HUB_MAC_HARDWARE: "price_mac_hw",
  PRICE_HUB_NVIDIA_MONTHLY: "price_nv_m", PRICE_HUB_NVIDIA_ANNUAL: "price_nv_a", PRICE_HUB_NVIDIA_HARDWARE: "price_nv_hw",
  ...over,
});

export interface TestUser { id: string; email: string; accountId: string; role: "owner" | "member" }

/** Owner with a fixed id and account; replaces any previous rows with the same ids. */
export async function seedOwner(id: string, accountId = id): Promise<TestUser> {
  await removeUser(id, accountId);
  const email = `${id}@example.com`;
  await e.DB.batch([
    e.DB.prepare("INSERT INTO users (id,email) VALUES (?,?)").bind(id, email),
    e.DB.prepare("INSERT INTO accounts (id,owner) VALUES (?,?)").bind(accountId, id),
    e.DB.prepare("INSERT INTO members (account_id,user_id,role) VALUES (?,?,'owner')").bind(accountId, id),
  ]);
  return { id, email, accountId, role: "owner" };
}
export async function seedMember(id: string, accountId: string): Promise<TestUser> {
  await e.DB.batch([
    e.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
    e.DB.prepare("DELETE FROM members WHERE user_id = ?").bind(id),
    e.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
    e.DB.prepare("INSERT INTO users (id,email) VALUES (?,?)").bind(id, `${id}@example.com`),
    e.DB.prepare("INSERT INTO members (account_id,user_id,role) VALUES (?,?,'member')").bind(accountId, id),
  ]);
  return { id, email: `${id}@example.com`, accountId, role: "member" };
}
export async function removeUser(id: string, accountId = id) {
  await e.DB.batch([
    e.DB.prepare("DELETE FROM sessions WHERE user_id = ? OR account_id = ?").bind(id, accountId),
    e.DB.prepare("DELETE FROM passkeys WHERE user_id = ?").bind(id),
    e.DB.prepare("DELETE FROM members WHERE user_id = ? OR account_id = ?").bind(id, accountId),
    e.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(accountId),
    e.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);
}

/** Creates a real session row and returns the Cookie header value. */
export async function login(u: TestUser): Promise<string> {
  const token = randomToken(), ts = now();
  await e.DB.prepare("INSERT INTO sessions (id,token_hash,user_id,account_id,created_at,last_seen,expires_at) VALUES (?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), await sha256(token), u.id, u.accountId, ts, ts, ts + ABSOLUTE_SECONDS).run();
  return `${SESSION_COOKIE}=${token}`;
}

/** A client for the real app. `cookie` undefined = anonymous. Browser CSRF headers are added. */
export function client(cookie?: string, bindings: Bindings = testBindings()) {
  return {
    request: (path: string, init: RequestInit = {}, b: Bindings = bindings) => app.request(ORIGIN + path, {
      ...init,
      headers: { "X-Requested-With": "albena-portal", Origin: ORIGIN, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(init.headers as Record<string, string> | undefined) },
    }, b),
  };
}

export async function lastAuditId(): Promise<number> {
  return (await e.DB.prepare("SELECT COALESCE(MAX(id),0) AS id FROM audit_log").first<{ id: number }>())!.id;
}
export async function auditSince(id: number): Promise<{ action: string; target: string | null }[]> {
  return (await e.DB.prepare("SELECT action, target FROM audit_log WHERE id > ? ORDER BY id").bind(id).all<{ action: string; target: string | null }>()).results;
}
export async function clearPortalTables() {
  await e.DB.batch(["stripe_events", "entitlements", "billing_customers", "hardware_orders", "hubs", "hub_pair_codes", "hub_nonces", "hub_metrics", "hub_rate", "releases", "refunds", "checkout_pending"]
    .map(t => e.DB.prepare(`DELETE FROM ${t}`)));
}

export interface FakeStripe {
  subs: Record<string, any>; sessions: Record<string, any>; calls: { method: string; path: string; params: URLSearchParams; key?: string }[];
  failPaths: Set<string>;
}
/** In-memory Stripe API. Install with fake.install(); state is plain objects tests can mutate. */
export function fakeStripe(): FakeStripe & { install: () => void } {
  const st: FakeStripe = { subs: {}, sessions: {}, calls: [], failPaths: new Set() };
  const byKey = new Map<string, any>();
  let n = 0;
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
  const impl = async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    if (u.hostname !== "api.stripe.com") return json({ success: true });
    const path = u.pathname.replace("/v1", "");
    const method = String(init.method ?? "GET");
    const params = new URLSearchParams(method === "GET" ? u.search : init.body ?? "");
    const key = init.headers?.["Idempotency-Key"];
    st.calls.push({ method, path, params, key });
    if ([...st.failPaths].some((f) => path.startsWith(f))) return json({ error: "boom" }, 500);
    let m: RegExpMatchArray | null;
    if (method === "POST" && path === "/customers") return json({ id: "cus_new" });
    if (path === "/subscriptions" && method === "GET") return json({ data: Object.values(st.subs).filter((s) => s.customer === params.get("customer")), has_more: false });
    if ((m = path.match(/^\/subscriptions\/([^/]+)$/))) {
      const s = st.subs[m[1]];
      if (!s) return json({ error: "nf" }, 404);
      if (method === "DELETE") { s.status = "canceled"; return json(s); }
      return json(s);
    }
    if (path === "/checkout/sessions" && method === "GET") return json({ data: Object.values(st.sessions).filter((s) => s.customer === params.get("customer") && s.status === params.get("status")), has_more: false });
    if (path === "/checkout/sessions" && method === "POST") {
      if (key && byKey.has(key)) return json(byKey.get(key));
      const id = `cs_new_${++n}`;
      const s = { id, status: "open", url: `https://checkout.stripe.com/c/${id}`, customer: params.get("customer"), line_items: { data: [] } };
      st.sessions[id] = s; if (key) byKey.set(key, s);
      return json(s);
    }
    if ((m = path.match(/^\/checkout\/sessions\/([^/]+)\/expire$/))) { const s = st.sessions[m[1]]; if (!s) return json({}, 404); s.status = "expired"; return json(s); }
    if ((m = path.match(/^\/checkout\/sessions\/([^/]+)$/))) { const s = st.sessions[m[1]]; return s ? json(s) : json({}, 404); }
    if (path.startsWith("/billing_portal")) return json({ url: "https://billing.stripe.com/p/x" });
    if (path === "/invoices") return json({ data: [{ id: "in_1", number: "A-1", status: "paid", amount_paid: 100, amount_due: 0, currency: "usd", created: 1, hosted_invoice_url: "h", invoice_pdf: "p", secret: "x" }] });
    return json({ error: "unmocked " + method + " " + path }, 500);
  };
  return Object.assign(st, { install: () => vi.stubGlobal("fetch", vi.fn(impl)) });
}
