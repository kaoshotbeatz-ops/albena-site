import { MAX_HUBS, type Plan } from "./plans";

export type EntitlementStatus = "active" | "trialing" | "past_due" | "canceled" | "incomplete" | "none" | "suspended" | "expired";
export type EntitlementSource = "stripe" | "manual";
export interface Entitlement {
  plan: Plan | "pilot" | "none";
  status: EntitlementStatus;
  /** true when the account may use paid features (active or trialing, and not past a manual end date) */
  active: boolean;
  billingInterval: string | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  stripeSubscriptionId: string | null;
  /** Hubs the account may have; 0 unless the entitlement is active. */
  maxHubs: number;
  /** 'manual' = granted by staff (pilot, comp, hand-set plan). Stripe overrides a manual grant only once a subscription is active. */
  source: EntitlementSource;
  /** Manual grants only: unix seconds when the grant lapses, or null. */
  endsAt: number | null;
  comp: boolean;
}

const NONE: Entitlement = { plan: "none", status: "none", active: false, billingInterval: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, stripeSubscriptionId: null, maxHubs: 0, source: "stripe", endsAt: null, comp: false };

/** The single entitlement lookup, also used by the hubs module. */
export async function getEntitlement(db: D1Database, accountId: string): Promise<Entitlement> {
  const r = await db.prepare("SELECT * FROM entitlements WHERE account_id = ?").bind(accountId).first<any>();
  if (!r) return { ...NONE };
  const lapsed = r.ends_at != null && r.ends_at <= Math.floor(Date.now() / 1000);
  const active = (r.status === "active" || r.status === "trialing") && !lapsed;
  return {
    plan: r.plan, status: r.status, active, maxHubs: active ? (r.max_hubs ?? MAX_HUBS[r.plan as Plan] ?? 0) : 0,
    billingInterval: r.billing_interval ?? null, currentPeriodEnd: r.current_period_end ?? null,
    cancelAtPeriodEnd: !!r.cancel_at_period_end, stripeSubscriptionId: r.stripe_subscription_id ?? null,
    source: r.source === "manual" ? "manual" : "stripe", endsAt: r.ends_at ?? null, comp: !!r.comp,
  };
}

export interface EntitlementState {
  plan: string; status: string; billing_interval?: string | null; stripe_subscription_id?: string | null;
  current_period_end?: number | null; cancel_at_period_end?: number;
}

export async function recordHistory(db: D1Database, h: { accountId: string; actor: string; kind: string; source: string; plan?: string | null; status?: string | null; endsAt?: number | null; note?: string | null }): Promise<void> {
  await db.prepare("INSERT INTO entitlement_history (account_id, at, actor, kind, source, plan, status, ends_at, note) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(h.accountId, Math.floor(Date.now() / 1000), h.actor, h.kind, h.source, h.plan ?? null, h.status ?? null, h.endsAt ?? null, h.note ?? null).run();
}

/**
 * Writes the full entitlement state in ONE conditional UPSERT. The write is refused (returns false) when
 *  - it is not newer than the stored state by (event created, event id), or
 *  - the account already tracks a different, non-terminal subscription (duplicate subscriptions never overwrite it), or
 *  - the stored grant is MANUAL and this state is not active/trialing. Precedence: a manual grant is replaced by Stripe only
 *    when a Stripe subscription becomes active; the manual grant is then archived to entitlement_history.
 * No stale read is merged, so concurrent or out-of-order deliveries cannot resurrect old state.
 */
export async function applyEntitlement(db: D1Database, accountId: string, s: EntitlementState, eventCreated: number, eventId = ""): Promise<boolean> {
  const prior = await db.prepare("SELECT source, plan, status, ends_at, note FROM entitlements WHERE account_id = ?").bind(accountId).first<{ source: string; plan: string; status: string; ends_at: number | null; note: string | null }>();
  const r = await db.prepare(
    `INSERT INTO entitlements (account_id, plan, status, billing_interval, stripe_subscription_id, current_period_end, cancel_at_period_end, last_event_created, last_event_id, updated_at, source)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'stripe')
     ON CONFLICT(account_id) DO UPDATE SET plan=excluded.plan, status=excluded.status, billing_interval=excluded.billing_interval,
       stripe_subscription_id=excluded.stripe_subscription_id, current_period_end=excluded.current_period_end,
       cancel_at_period_end=excluded.cancel_at_period_end, last_event_created=excluded.last_event_created,
       last_event_id=excluded.last_event_id, updated_at=excluded.updated_at,
       source='stripe', ends_at=NULL, note=NULL, max_hubs=NULL, comp=0
     WHERE (entitlements.stripe_subscription_id IS NULL OR entitlements.stripe_subscription_id = excluded.stripe_subscription_id OR entitlements.status IN ('canceled','none'))
       AND (entitlements.source = 'stripe' OR excluded.status IN ('active','trialing'))
       AND (excluded.last_event_created > entitlements.last_event_created
            OR (excluded.last_event_created = entitlements.last_event_created AND excluded.last_event_id > entitlements.last_event_id))`,
  ).bind(accountId, s.plan, s.status, s.billing_interval ?? null, s.stripe_subscription_id ?? null, s.current_period_end ?? null,
    s.cancel_at_period_end ?? 0, eventCreated, eventId, Math.floor(Date.now() / 1000)).run();
  const applied = (r.meta?.changes ?? 0) > 0;
  if (applied && prior?.source === "manual") {
    await recordHistory(db, { accountId, actor: "system:stripe", kind: "archived_by_stripe", source: "manual", plan: prior.plan, status: prior.status, endsAt: prior.ends_at, note: prior.note });
  }
  return applied;
}

/** Outstanding pairing codes are worthless without an active entitlement; drop them. */
export async function dropCodesIfInactive(db: D1Database, accountId: string): Promise<void> {
  await db.prepare(
    `DELETE FROM hub_pair_codes WHERE account_id = ? AND used_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM entitlements WHERE account_id = ? AND status IN ('active','trialing') AND (ends_at IS NULL OR ends_at > ?))`,
  ).bind(accountId, accountId, Math.floor(Date.now() / 1000)).run();
}

export interface ManualGrant {
  plan: string; status: "active" | "suspended"; endsAt: number | null; note: string | null; maxHubs: number | null; comp: boolean;
}
/**
 * Writes a manual grant. Refused (false) while a live Stripe subscription backs the account: Stripe is authoritative there.
 * Keeps last_event_* so late Stripe events for earlier state stay ordered.
 */
export async function writeManualEntitlement(db: D1Database, accountId: string, g: ManualGrant): Promise<boolean> {
  const r = await db.prepare(
    `INSERT INTO entitlements (account_id, plan, status, billing_interval, stripe_subscription_id, current_period_end, cancel_at_period_end, last_event_created, last_event_id, updated_at, source, ends_at, note, max_hubs, comp)
     VALUES (?1,?2,?3,NULL,NULL,NULL,0,0,'',?4,'manual',?5,?6,?7,?8)
     ON CONFLICT(account_id) DO UPDATE SET plan=excluded.plan, status=excluded.status, billing_interval=NULL, stripe_subscription_id=NULL,
       current_period_end=NULL, cancel_at_period_end=0, updated_at=excluded.updated_at, source='manual', ends_at=excluded.ends_at,
       note=excluded.note, max_hubs=excluded.max_hubs, comp=excluded.comp
     WHERE entitlements.source = 'manual' OR entitlements.stripe_subscription_id IS NULL OR entitlements.status IN ('canceled','none')`,
  ).bind(accountId, g.plan, g.status, Math.floor(Date.now() / 1000), g.endsAt, g.note, g.maxHubs, g.comp ? 1 : 0).run();
  return (r.meta?.changes ?? 0) > 0;
}
