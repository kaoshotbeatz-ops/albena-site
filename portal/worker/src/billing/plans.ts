import type { Bindings } from "../types";

export type Plan = "byo" | "hub_mac" | "hub_nvidia" | "estate";
export type Interval = "monthly" | "annual";
export const PLANS: Plan[] = ["byo", "hub_mac", "hub_nvidia", "estate"];
/** Plans staff can grant by hand: the four paid plans plus a time-boxed pilot and a complimentary copy of a paid plan. */
export type GrantPlan = Plan | "pilot" | "comp";
export const GRANT_PLANS: GrantPlan[] = ["byo", "hub_mac", "hub_nvidia", "estate", "pilot", "comp"];
export const isHardware = (p: Plan) => p === "hub_mac" || p === "hub_nvidia";

/** Hubs an account may pair. Applies only while the entitlement is active. */
/** A pilot defaults to one Hub; a manual grant may override this per account (entitlements.max_hubs). */
export const MAX_HUBS: Record<Plan | "pilot" | "none", number> = { byo: 1, hub_mac: 1, hub_nvidia: 1, estate: 5, pilot: 1, none: 0 };

/** Price IDs come from vars: PRICE_<PLAN>_<MONTHLY|ANNUAL>, and PRICE_<PLAN>_HARDWARE for hubs. */
export function priceId(env: Bindings, plan: Plan, kind: "MONTHLY" | "ANNUAL" | "HARDWARE"): string | undefined {
  return (env as unknown as Record<string, string | undefined>)[`PRICE_${plan.toUpperCase()}_${kind}`] || undefined;
}
