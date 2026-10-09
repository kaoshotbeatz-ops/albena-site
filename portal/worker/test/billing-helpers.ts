import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "../src/_stubs";
import { mount } from "../src/billing";
import { hmacHex } from "../src/billing/signature";

/** Minimal D1 shim over node:sqlite (Node 24) for tests. */
// vite strips the node: prefix for sqlite; load via getBuiltinModule
const { DatabaseSync } = (process as any).getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

export function makeD1(): D1Database {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(fileURLToPath(new URL("../migrations/0200_billing_init.sql", import.meta.url) as any), "utf8"));
  const fix = (a: unknown[]) => a.map((v) => (v === undefined ? null : v)) as any[];
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    run: async () => { const r = sql.prepare(q).run(...fix(args)); return { success: true, meta: { changes: Number(r.changes) } }; },
    first: async () => (sql.prepare(q).get(...fix(args)) as any) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...fix(args)) as any[] }),
  });
  return { prepare: (q: string) => stmt(q) } as unknown as D1Database;
}

export const SECRET = "whsec_test_secret";
export const ENV = (db: D1Database): Bindings => ({
  DB: db, STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: SECRET,
  PRICE_BYO_MONTHLY: "price_byo_m", PRICE_BYO_ANNUAL: "price_byo_a",
  PRICE_HUB_MAC_MONTHLY: "price_mac_m", PRICE_HUB_MAC_ANNUAL: "price_mac_a", PRICE_HUB_MAC_HARDWARE: "price_mac_hw",
  PRICE_HUB_NVIDIA_MONTHLY: "price_nv_m", PRICE_HUB_NVIDIA_ANNUAL: "price_nv_a", PRICE_HUB_NVIDIA_HARDWARE: "price_nv_hw",
});

export function makeApp(user: { id: string; email: string; role: "owner" | "member"; accountId: string } | null = { id: "u1", email: "o@x.com", role: "owner", accountId: "acct_1" }) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { if (user) c.set("user", user); await next(); });
  mount(app);
  return app;
}

export async function sign(body: string, ts = Math.floor(Date.now() / 1000), secret = SECRET) {
  return `t=${ts},v1=${await hmacHex(secret, `${ts}.${body}`)}`;
}

export async function postEvent(app: ReturnType<typeof makeApp>, env: Bindings, ev: object, header?: string) {
  const body = JSON.stringify(ev);
  return app.request("/api/stripe/webhook", { method: "POST", body, headers: { "Stripe-Signature": header ?? (await sign(body)) } }, env);
}
