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

export interface EntitlementState {
  plan: string; status: string; billing_interval?: string | null; stripe_subscription_id?: string | null;
  current_period_end?: number | null; cancel_at_period_end?: number;
}

/**
 * Writes the full entitlement state in ONE conditional UPSERT. The write is refused (returns false) when
 *  - it is not newer than the stored state by (event created, event id), or
 *  - the account already tracks a different, non-terminal subscription (duplicate subscriptions never overwrite it).
 * No stale read is merged, so concurrent or out-of-order deliveries cannot resurrect old state.
 */
export async function applyEntitlement(db: D1Database, accountId: string, s: EntitlementState, eventCreated: number, eventId = ""): Promise<boolean> {
  const r = await db.prepare(
    `INSERT INTO entitlements (account_id, plan, status, billing_interval, stripe_subscription_id, current_period_end, cancel_at_period_end, last_event_created, last_event_id, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(account_id) DO UPDATE SET plan=excluded.plan, status=excluded.status, billing_interval=excluded.billing_interval,
       stripe_subscription_id=excluded.stripe_subscription_id, current_period_end=excluded.current_period_end,
       cancel_at_period_end=excluded.cancel_at_period_end, last_event_created=excluded.last_event_created,
       last_event_id=excluded.last_event_id, updated_at=excluded.updated_at
     WHERE (entitlements.stripe_subscription_id IS NULL OR entitlements.stripe_subscription_id = excluded.stripe_subscription_id OR entitlements.status IN ('canceled','none'))
       AND (excluded.last_event_created > entitlements.last_event_created
            OR (excluded.last_event_created = entitlements.last_event_created AND excluded.last_event_id > entitlements.last_event_id))`,
  ).bind(accountId, s.plan, s.status, s.billing_interval ?? null, s.stripe_subscription_id ?? null, s.current_period_end ?? null,
    s.cancel_at_period_end ?? 0, eventCreated, eventId, Math.floor(Date.now() / 1000)).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** Outstanding pairing codes are worthless without an active entitlement; drop them. */
export async function dropCodesIfInactive(db: D1Database, accountId: string): Promise<void> {
  await db.prepare(
    `DELETE FROM hub_pair_codes WHERE account_id = ? AND used_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM entitlements WHERE account_id = ? AND status IN ('active','trialing'))`,
  ).bind(accountId, accountId).run();
}
