import type { Bindings } from "../types";
import { applyEntitlement, dropCodesIfInactive } from "./entitlements";
import { PLANS, priceId, type Interval, type Plan } from "./plans";
import { stripe, StripeError } from "./stripe";

/** Subscription states that can still bill or become billable. Everything else is terminal. */
export const NON_TERMINAL = ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"] as const;
export const isNonTerminal = (s: unknown) => (NON_TERMINAL as readonly string[]).includes(String(s));

const SUB_ID = /^sub_[A-Za-z0-9_]+$/;

/** Current recurring price ids (PRICE_* vars) -> plan and interval. This, not metadata, decides what was bought. */
export function priceCatalog(env: Bindings): Map<string, { plan: Plan; interval: Interval }> {
  const m = new Map<string, { plan: Plan; interval: Interval }>();
  for (const plan of PLANS) {
    const mo = priceId(env, plan, "MONTHLY"), an = priceId(env, plan, "ANNUAL");
    if (mo) m.set(mo, { plan, interval: "monthly" });
    if (an) m.set(an, { plan, interval: "annual" });
  }
  return m;
}
export function hardwareCatalog(env: Bindings): Map<string, Plan> {
  const m = new Map<string, Plan>();
  for (const plan of PLANS) { const id = priceId(env, plan, "HARDWARE"); if (id) m.set(id, plan); }
  return m;
}

export function normalizeStatus(s: string): string {
  switch (s) {
    case "active": case "trialing": case "incomplete": return s;
    case "canceled": case "incomplete_expired": return "canceled";
    default: return "past_due"; // past_due, unpaid, paused, anything new: never active
  }
}

export async function fetchSubscription(env: Bindings, id: string): Promise<any | null> {
  if (!SUB_ID.test(id)) return null;
  try { return await stripe(env, "GET", `/subscriptions/${id}`); }
  catch (e) { if (e instanceof StripeError && e.status === 404) return null; throw e; }
}

const custId = (o: any): string | null => (typeof o?.customer === "string" ? o.customer : o?.customer?.id ?? null);

export async function accountForCustomer(db: D1Database, customer: string | null): Promise<string | null> {
  if (!customer) return null;
  return (await db.prepare("SELECT account_id FROM billing_customers WHERE stripe_customer_id = ?").bind(customer).first<{ account_id: string }>())?.account_id ?? null;
}

export interface Ord { created: number; id: string }
export type ReconcileResult = { account: string; applied: boolean; duplicate?: boolean } | null;

/**
 * Fetches the subscription from Stripe (the authority) and writes the entitlement derived from it.
 * Plan and interval come from the allowlisted price ids; metadata is never trusted for entitlement.
 * `hintAccount` is the account Checkout was created for, used only when the customer is not mapped yet.
 */
export async function reconcileSubscription(env: Bindings, subId: string, ord: Ord, hintAccount?: string, retry = true): Promise<ReconcileResult> {
  const db = env.DB;
  const sub = await fetchSubscription(env, subId);
  let account: string | null;
  let state: Parameters<typeof applyEntitlement>[2];
  if (!sub) {
    // Purged/unknown at Stripe: if we track it, it is over.
    const row = await db.prepare("SELECT account_id FROM entitlements WHERE stripe_subscription_id = ?").bind(subId).first<{ account_id: string }>();
    if (!row) return null;
    account = row.account_id;
    state = { plan: "none", status: "canceled", stripe_subscription_id: subId };
  } else {
    const mapped = await accountForCustomer(db, custId(sub));
    if (mapped && hintAccount && mapped !== hintAccount) return null;
    account = mapped ?? hintAccount ?? null;
    if (!account) return null;
    const cat = priceCatalog(env);
    const hit = (sub.items?.data ?? []).map((i: any) => cat.get(i?.price?.id)).find(Boolean);
    const status = hit ? normalizeStatus(String(sub.status)) : "none"; // unknown price: fail closed, no entitlement
    state = {
      plan: hit?.plan ?? "none", status, billing_interval: hit?.interval ?? null, stripe_subscription_id: sub.id,
      current_period_end: sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null,
      cancel_at_period_end: sub.cancel_at_period_end ? 1 : 0,
    };
  }
  let applied = await applyEntitlement(db, account, state, ord.created, ord.id);
  let duplicate = false;
  if (!applied) {
    const cur = await db.prepare("SELECT stripe_subscription_id AS s, status FROM entitlements WHERE account_id = ?").bind(account).first<{ s: string | null; status: string }>();
    if (cur?.s && cur.s !== subId && isNonTerminal(cur.status)) {
      // A different subscription is tracked. Refresh it from Stripe in case it already ended, then retry once.
      if (retry) {
        await reconcileSubscription(env, cur.s, ord, account, false);
        return reconcileSubscription(env, subId, { created: ord.created, id: `${ord.id}~` }, hintAccount, false); // sorts just after the refresh
      }
      duplicate = true;
    }
  }
  await dropCodesIfInactive(db, account);
  return { account, applied, ...(duplicate ? { duplicate } : {}) };
}
