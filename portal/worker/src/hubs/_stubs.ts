// Stubs with the CONTRACT.md signatures. The merge replaces imports with ../auth and ../billing.
import type { Context, MiddlewareHandler } from "hono";

export interface D1Like {
  prepare(sql: string): any;
  batch(stmts: any[]): Promise<any[]>;
}
export type PortalUser = { id: string; email: string; role: "owner" | "member"; accountId: string };
export type AppEnv = {
  Bindings: { DB: D1Like; HUB_CODE_PEPPER?: string };
  Variables: { user: PortalUser; requestId: string };
};

/** Stub: trusts test header X-Test-User: id|email|role|accountId. Real one: GPT-6 auth. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const raw = c.req.header("x-test-user");
  if (!raw) return c.json({ error: "unauthorized" }, 401);
  const [id, email, role, accountId] = raw.split("|");
  c.set("user", { id, email, role: role as "owner" | "member", accountId });
  await next();
};

/** Stub: real one writes the hash-chained audit_log. */
export const auditLog: { action: string; target: string; meta?: unknown }[] = [];
export async function audit(_c: Context<AppEnv>, action: string, target: string, meta?: Record<string, unknown>): Promise<void> {
  auditLog.push({ action, target, meta });
}

/** Stub: real one from billing. maxHubs = hubs the plan allows. */
export let stubMaxHubs = 1;
export function setStubMaxHubs(n: number) { stubMaxHubs = n; }
export async function getEntitlement(_c: Context<AppEnv>, _accountId: string): Promise<{ maxHubs: number }> {
  return { maxHubs: stubMaxHubs };
}
