/**
 * Vitest configuration for integration tests.
 *
 * Separate from vitest.config.ts (unit tests) — integration tests:
 *   - require real Docker containers (PostgreSQL + Redis via testcontainers)
 *   - take 30–120 seconds to run (container boot + migration + E2E flow)
 *   - must NOT run as part of the default `pnpm test` CI step
 *
 * Run with: pnpm --filter @breatic/server test:integration
 */

import type {} from "@breatic/integration-tests/provided-context";
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    globals: true,
    // The complement of what vitest.config.ts excludes. A narrower pattern
    // would let a case named per the repo's own test-file rule — a sibling
    // __tests__/ next to the module — run in neither config, committed and
    // green and never executed.
    include: ["src/**/*.integration.test.ts"],
    // globalSetup starts testcontainers BEFORE any test module is imported,
    // then lays down the payment configs only this package's suites read.
    globalSetup: [
      "@breatic/integration-tests/containers",
      "./src/__tests__/integration/payment-configs.ts",
    ],
    // setupFiles runs inside the worker process. Re-applies env vars from globalSetup.
    setupFiles: ["@breatic/integration-tests/env"],
    // Single fork: one worker process, one container set, no port conflicts.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Long timeout: testcontainers + migration + BullMQ job execution
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      "@server": resolve(__dirname, "./src"),
      // A test that reaches for a real tool imports the domain source
      // directly, and that source uses domain's own alias.
      "@domain": resolve(__dirname, "../domain/src"),
    },
  },
});
