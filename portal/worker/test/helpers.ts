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
  await e.DB.batch(["stripe_events", "entitlements", "billing_customers", "hardware_orders", "hubs", "hub_pair_codes", "hub_nonces", "hub_rate", "releases"]
    .map(t => e.DB.prepare(`DELETE FROM ${t}`)));
}
