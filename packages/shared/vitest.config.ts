import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    // One process for this package instead of one per file. Turbo already
    // runs packages in parallel; the second layer of per-file processes is
    // what took a twelve-core machine to 37 processes and a load average of
    // 26, and each of those processes paid the same fixed setup cost over
    // again. Isolation stays on. Measurements are in
    // packages/web/vitest.config.ts, where the effect was largest.
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
