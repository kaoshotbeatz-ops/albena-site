import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["../test/hubs*.test.ts"], root: "." } });
