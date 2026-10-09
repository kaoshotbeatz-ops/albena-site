import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      compatibilityDate: "2026-08-22",
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        TURNSTILE_SECRET_KEY: "test-only", PORTAL_SECRETS: "test-only-privacy-key",
        ENVIRONMENT: "test", MAIL_PROVIDER: "dev",
      },
    },
  })],
  test: { setupFiles: ["./test/setup.ts"] },
}));
