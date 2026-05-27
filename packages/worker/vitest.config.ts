import { defineConfig } from "vitest/config";

// See packages/core/vitest.config.ts for the 5s → 15s rationale.
export default defineConfig({
  test: {
    testTimeout: 15_000,
  },
});
