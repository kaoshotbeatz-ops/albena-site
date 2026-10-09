// TEMPORARY stubs per portal/CONTRACT.md. Replaced by src/auth + src/types.ts when GPT-6's skeleton merges.
import type { Context, MiddlewareHandler } from "hono";

export interface Bindings {
  DB: D1Database;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  PORTAL_BASE_URL?: string;
  [priceVar: `PRICE_${string}`]: string | undefined;
}
export type AppUser = { id: string; email: string; role: "owner" | "member"; accountId: string };
export type AppEnv = { Bindings: Bindings; Variables: { user: AppUser; requestId: string } };

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("user")) return c.json({ error: "unauthorized" }, 401);
  await next();
};

export const auditEntries: { action: string; target: string; meta?: unknown }[] = [];
export async function audit(_c: Context<AppEnv>, action: string, target: string, meta?: Record<string, unknown>): Promise<void> {
  auditEntries.push({ action, target, meta });
}
