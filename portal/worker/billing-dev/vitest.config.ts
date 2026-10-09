import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
const dir = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  resolve: { alias: { hono: dir + "node_modules/hono" } },
  test: { include: ["test/billing*.test.ts"], environment: "node" },
});
