import type { Context } from "hono";
import type { AppEnv } from "../types";
import { audit } from "../auditchain";
import { dropCodesIfInactive, recordHistory, writeManualEntitlement } from "../billing/entitlements";
import { GRANT_PLANS, PLANS, type GrantPlan, type Plan } from "../billing/plans";

export const now = () => Math.floor(Date.now() / 1000);
export const DAY = 86400;
export type Obj = Record<string, unknown>;
export const readObj = async (c: Context<AppEnv>): Promise<Obj> => {
  const v = await c.req.json().catch(() => null);
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
};
export const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim().length > 0 && v.trim().length <= max ? v.trim() : null);
const int = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null);

/** Plan fields shared by a direct grant and an invite. `plan` is the requested kind; `stored` is what lands in entitlements.plan. */
export interface PlanFields { plan: GrantPlan; stored: Plan | "pilot"; comp: boolean; basePlan: Plan | null; days: number | null }
export function parsePlanFields(b: Obj): PlanFields | { error: string } {
  if (!GRANT_PLANS.includes(b.plan as GrantPlan)) return { error: "invalid_plan" };
  const plan = b.plan as GrantPlan;
  let basePlan: Plan | null = null;
  if (plan === "comp") {
    if (!PLANS.includes(b.basePlan as Plan)) return { error: "base_plan_required" };
    basePlan = b.basePlan as Plan;
  }
  let days: number | null = null;
  if (b.days !== undefined) { days = int(b.days, 1, 730); if (days === null) return { error: "invalid_days" }; }
  if (plan === "pilot" && days === null) days = 30;
  return { plan, stored: plan === "comp" ? basePlan! : plan, comp: plan === "comp", basePlan, days };
}

type Existing = { source: string; plan: string; status: string; ends_at: number | null; note: string | null; max_hubs: number | null; comp: number; stripe_subscription_id: string | null };

/**
 * Staff grant/extend/suspend/reactivate in one call. With an existing manual grant `plan` may be omitted (suspend, reactivate, extend).
 * Returns the history kind on success. A Stripe subscription that is still live always wins: staff cannot overwrite it.
 */
export async function grantEntitlement(c: Context<AppEnv>, accountId: string, b: Obj): Promise<{ ok: true; kind: string } | { ok: false; status: 400 | 409; error: string }> {
  const db = c.env.DB, ts = now();
  const prior = await db.prepare("SELECT source, plan, status, ends_at, note, max_hubs, comp, stripe_subscription_id FROM entitlements WHERE account_id = ?").bind(accountId).first<Existing>();
  const stripeLive = !!prior && prior.source === "stripe" && !!prior.stripe_subscription_id && !["canceled", "none"].includes(prior.status);
  if (stripeLive) return { ok: false, status: 409, error: "stripe_subscription_active" };

  const status = b.status === undefined ? "active" : b.status;
  if (status !== "active" && status !== "suspended") return { ok: false, status: 400, error: "invalid_status" };
  const keep = prior?.source === "manual" && b.plan === undefined ? prior : null;
  let stored: string, comp: boolean;
  if (keep) { stored = keep.plan; comp = !!keep.comp; }
  else {
    if (b.plan === undefined) return { ok: false, status: 400, error: "plan_required" };
    const f = parsePlanFields(b);
    if ("error" in f) return { ok: false, status: 400, error: f.error };
    stored = f.stored; comp = f.comp;
    if (b.days === undefined && f.days !== null) b = { ...b, days: f.days };
  }
  let endsAt: number | null = keep ? keep.ends_at : null;
  if (b.ends_at !== undefined) {
    if (b.ends_at === null) endsAt = null;
    else if (typeof b.ends_at === "number" && Number.isInteger(b.ends_at) && b.ends_at < ts + 5 * 366 * DAY) endsAt = b.ends_at;
    else return { ok: false, status: 400, error: "invalid_ends_at" };
  } else if (b.days !== undefined) {
    const d = int(b.days, 1, 730);
    if (d === null) return { ok: false, status: 400, error: "invalid_days" };
    endsAt = ts + d * DAY;
  }
  if (status === "active" && endsAt !== null && endsAt <= ts) return { ok: false, status: 400, error: "ends_at_in_past" };
  let maxHubs: number | null = keep ? keep.max_hubs : null;
  if (b.maxHubs !== undefined) {
    if (b.maxHubs === null) maxHubs = null;
    else { maxHubs = int(b.maxHubs, 1, 50); if (maxHubs === null) return { ok: false, status: 400, error: "invalid_max_hubs" }; }
  }
  let note: string | null = keep ? keep.note : null;
  if (b.note !== undefined) { note = b.note === null ? null : text(b.note, 500); if (b.note !== null && note === null) return { ok: false, status: 400, error: "invalid_note" }; }

  if (!(await writeManualEntitlement(db, accountId, { plan: stored, status, endsAt, note, maxHubs, comp }))) return { ok: false, status: 409, error: "stripe_subscription_active" };
  const kind = status === "suspended" ? "suspend"
    : prior?.source === "manual" && prior.status !== "active" && prior.plan === stored ? "reactivate"
    : prior?.source === "manual" && prior.plan === stored && !!prior.comp === comp ? "extend" : "grant";
  await recordHistory(db, { accountId, actor: `support:${c.get("supportActor")}`, kind, source: "manual", plan: comp ? `comp:${stored}` : stored, status, endsAt, note });
  if (status === "suspended") await dropCodesIfInactive(db, accountId);
  await audit(c, `support.entitlement.${kind}`, accountId, { plan: stored, comp, status, endsAt, maxHubs });
  return { ok: true, kind };
}
