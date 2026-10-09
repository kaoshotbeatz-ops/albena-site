import type { Hono } from "hono";
import type { AppEnv } from "./types";
import * as auth from "./auth";
import * as billing from "./billing";
import * as hubs from "./hubs";
import * as account from "./account";

// Static imports on purpose: a broken module must fail at startup, not be swallowed.
export const modules: ReadonlyArray<{ mount(app: Hono<AppEnv>): void; migrations: string[] }> = [auth, billing, hubs, account];
