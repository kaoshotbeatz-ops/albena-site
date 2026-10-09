import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { Bindings } from "../src/types";
const e = env as unknown as Bindings & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
