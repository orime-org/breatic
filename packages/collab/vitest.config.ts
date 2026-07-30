import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// See packages/core/vitest.config.ts for the 5s → 15s rationale.
export default defineConfig({
  test: {
    // One process per package — see packages/web/vitest.config.ts for the
    // measurements behind this. Isolation stays on.
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
