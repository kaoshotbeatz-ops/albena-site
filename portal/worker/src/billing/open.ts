import type { Bindings } from "../types";
import { isNonTerminal } from "./reconcile";
import { stripe } from "./stripe";

export interface OpenBilling { subscriptions: { id: string; status: string }[]; checkoutSessions: string[] }

async function listAll(env: Bindings, path: string, params: Record<string, unknown>): Promise<any[]> {
  const out: any[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await stripe<{ data: any[]; has_more?: boolean }>(env, "GET", path, { ...params, limit: 100, ...(after ? { starting_after: after } : {}) });
    out.push(...r.data);
    if (!r.has_more || !r.data.length) return out;
    after = r.data[r.data.length - 1].id;
  }
  throw new Error("too_many_billing_objects"); // fail closed rather than miss one
}

/** Everything at Stripe that can still bill this customer: non-terminal subscriptions and open Checkout sessions. */
export async function listOpenBilling(env: Bindings, customer: string): Promise<OpenBilling> {
  const subs = await listAll(env, "/subscriptions", { customer, status: "all" });
  const sessions = await listAll(env, "/checkout/sessions", { customer, status: "open" });
  return {
    subscriptions: subs.filter((s) => isNonTerminal(s.status)).map((s) => ({ id: s.id, status: s.status })),
    checkoutSessions: sessions.map((s) => s.id),
  };
}

/** Cancels subscriptions immediately and expires open sessions, then re-reads Stripe to prove nothing is left. */
export async function cancelOpenBilling(env: Bindings, customer: string, open: OpenBilling): Promise<boolean> {
  for (const s of open.subscriptions) await stripe(env, "DELETE", `/subscriptions/${s.id}`, { invoice_now: false, prorate: false });
  for (const id of open.checkoutSessions) await stripe(env, "POST", `/checkout/sessions/${id}/expire`);
  const left = await listOpenBilling(env, customer);
  return left.subscriptions.length === 0 && left.checkoutSessions.length === 0;
}
