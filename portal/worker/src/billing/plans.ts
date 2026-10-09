import type { Bindings } from "../_stubs";

export type Plan = "byo" | "hub_mac" | "hub_nvidia" | "estate";
export type Interval = "monthly" | "annual";
export const PLANS: Plan[] = ["byo", "hub_mac", "hub_nvidia", "estate"];
export const isHardware = (p: Plan) => p === "hub_mac" || p === "hub_nvidia";

/** Price IDs come from vars: PRICE_<PLAN>_<MONTHLY|ANNUAL>, and PRICE_<PLAN>_HARDWARE for hubs. */
export function priceId(env: Bindings, plan: Plan, kind: "MONTHLY" | "ANNUAL" | "HARDWARE"): string | undefined {
  return env[`PRICE_${plan.toUpperCase()}_${kind}`];
}
