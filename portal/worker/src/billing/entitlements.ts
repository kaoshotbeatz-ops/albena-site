import { MAX_HUBS, type Plan } from "./plans";

export type EntitlementStatus = "active" | "trialing" | "past_due" | "canceled" | "incomplete" | "none";
export interface Entitlement {
  plan: Plan | "none";
  status: EntitlementStatus;
  /** true when the account may use paid features (active or trialing) */
  active: boolean;
  billingInterval: string | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  stripeSubscriptionId: string | null;
  /** Hubs the account may have; 0 unless the entitlement is active. */
  maxHubs: number;
}

const NONE: Entitlement = { plan: "none", status: "none", active: false, billingInterval: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, stripeSubscriptionId: null, maxHubs: 0 };

/** The single entitlement lookup, also used by the hubs module. */
export async function getEntitlement(db: D1Database, accountId: string): Promise<Entitlement> {
  const r = await db.prepare("SELECT * FROM entitlements WHERE account_id = ?").bind(accountId).first<any>();
  if (!r) return { ...NONE };
  const active = r.status === "active" || r.status === "trialing";
  return {
    plan: r.plan, status: r.status, active, maxHubs: active ? (MAX_HUBS[r.plan as Plan] ?? 0) : 0,
    billingInterval: r.billing_interval ?? null, currentPeriodEnd: r.current_period_end ?? null,
    cancelAtPeriodEnd: !!r.cancel_at_period_end, stripeSubscriptionId: r.stripe_subscription_id ?? null,
  };
}

export interface EntitlementPatch {
  plan?: string; status?: string; billing_interval?: string | null; stripe_subscription_id?: string | null;
  current_period_end?: number | null; cancel_at_period_end?: number;
}

/** Merge patch into entitlement unless a newer event already applied (out-of-order delivery guard). */
export async function applyEntitlement(db: D1Database, accountId: string, patch: EntitlementPatch, eventCreated: number): Promise<boolean> {
  const cur = await db.prepare("SELECT * FROM entitlements WHERE account_id = ?").bind(accountId).first<any>();
  if (cur && cur.last_event_created > eventCreated) return false;
  const m = { plan: "none", status: "none", billing_interval: null, stripe_subscription_id: null, current_period_end: null, cancel_at_period_end: 0, ...(cur ?? {}), ...patch };
  await db.prepare(
    `INSERT INTO entitlements (account_id, plan, status, billing_interval, stripe_subscription_id, current_period_end, cancel_at_period_end, last_event_created, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(account_id) DO UPDATE SET plan=excluded.plan, status=excluded.status, billing_interval=excluded.billing_interval,
       stripe_subscription_id=excluded.stripe_subscription_id, current_period_end=excluded.current_period_end,
       cancel_at_period_end=excluded.cancel_at_period_end, last_event_created=excluded.last_event_created, updated_at=excluded.updated_at`,
  ).bind(accountId, m.plan, m.status, m.billing_interval, m.stripe_subscription_id, m.current_period_end, m.cancel_at_period_end, eventCreated, Math.floor(Date.now() / 1000)).run();
  return true;
}
