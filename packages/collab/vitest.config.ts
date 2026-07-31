import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// See packages/core/vitest.config.ts for the 5s → 15s rationale.
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
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      "@collab": resolve(__dirname, "./src"),
    },
  },
});
