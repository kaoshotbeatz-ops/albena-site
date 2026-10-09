import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // local workerd binary may lag the production compat date
          compatibilityDate: "2026-08-22",
          bindings: {
            TEST_MIGRATIONS: migrations,
            TURNSTILE_SECRET_KEY: "test-secret",
            IP_SALT: "test-salt",
            ADMIN_AUD: "test-aud",
            TEAM_DOMAIN: "team.example.cloudflareaccess.com",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
