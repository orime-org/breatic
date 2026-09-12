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
    // Integration suites are excluded here and run via
    // vitest.integration.config.ts. The HTTP layer takes no injected fetch and
    // no injected clock, so its cases open real ports and sit through real
    // backoffs — and `pnpm test` runs every package at once, so leaving them
    // in makes every other package's suite decide its timeouts on a busier
    // machine.
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts"],
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "./src"),
    },
  },
});
