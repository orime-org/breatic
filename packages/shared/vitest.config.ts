import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    // One process for this package instead of one per file — rationale and
    // measurements in packages/web/vitest.config.ts, where the effect was
    // largest.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
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
