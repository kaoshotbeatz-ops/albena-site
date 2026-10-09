import type { Hono } from "hono";
import type { AppEnv } from "./types";
import * as auth from "./auth";

// Add static imports and entries when the other builders deliver these modules.
// Do not dynamically swallow import errors: that can hide broken billing at startup.
export const pendingModules = ["billing", "hubs"] as const;
export const modules: ReadonlyArray<{ mount(app: Hono<AppEnv>): void }> = [auth];
