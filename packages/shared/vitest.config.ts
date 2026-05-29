import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    globals: true,
    // See packages/core/vitest.config.ts for the 5s → 15s rationale.
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "./src"),
    },
  },
});
