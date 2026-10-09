import type { Bindings } from "../types";

export type Plan = "byo" | "hub_mac" | "hub_nvidia" | "estate";
export type Interval = "monthly" | "annual";
export const PLANS: Plan[] = ["byo", "hub_mac", "hub_nvidia", "estate"];
export const isHardware = (p: Plan) => p === "hub_mac" || p === "hub_nvidia";

/** Hubs an account may pair. Applies only while the entitlement is active. */
export const MAX_HUBS: Record<Plan | "none", number> = { byo: 1, hub_mac: 1, hub_nvidia: 1, estate: 5, none: 0 };

/** Price IDs come from vars: PRICE_<PLAN>_<MONTHLY|ANNUAL>, and PRICE_<PLAN>_HARDWARE for hubs. */
export function priceId(env: Bindings, plan: Plan, kind: "MONTHLY" | "ANNUAL" | "HARDWARE"): string | undefined {
  return (env as unknown as Record<string, string | undefined>)[`PRICE_${plan.toUpperCase()}_${kind}`] || undefined;
}
