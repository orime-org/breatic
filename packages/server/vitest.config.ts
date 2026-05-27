import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/__tests__/**/*.test.ts"],
    exclude: ["src/__tests__/**/*.integration.test.ts"],
    // 5s default is too tight for bcrypt-cost-12 + property-based
    // round-trips under turbo parallelism — see
    // packages/core/vitest.config.ts for the full rationale.
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
});
