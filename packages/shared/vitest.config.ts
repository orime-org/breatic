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
    // 15s rather than vitest's 5s default: under turbo's cross-package
    // parallelism a test gets well under one core, and the 5s default was
    // failing @breatic/server's bcrypt invariant that passes in ~0.5s alone
    // (b35ae386). Raised everywhere so one package's contention does not
    // decide another's limit.
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "./src"),
    },
  },
});
