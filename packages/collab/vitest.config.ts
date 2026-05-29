import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// See packages/core/vitest.config.ts for the 5s → 15s rationale.
export default defineConfig({
  test: {
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      "@collab": resolve(__dirname, "./src"),
    },
  },
});
