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

import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/__tests__/integration/**/*.integration.test.ts"],
    // globalSetup starts testcontainers BEFORE any test module is imported.
    globalSetup: ["./src/__tests__/integration/global-setup.ts"],
    // setupFiles runs inside the worker process. Re-applies env vars from globalSetup.
    setupFiles: ["./src/__tests__/integration/integration-setup.ts"],
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
      // Allow integration tests to import from worker and collab source directly.
      "@breatic/worker/src": resolve(__dirname, "../worker/src"),
      "@breatic/collab/src": resolve(__dirname, "../collab/src"),
      // Worker and collab source modules reference their OWN code through the
      // package-local `@worker/*` and `@collab/*` path aliases (CLAUDE.md
      // rule #15: depended-on packages use a globally-unique prefix). When an
      // integration test imports that source (via the `@breatic/{worker,collab}/src`
      // aliases above), Vite must also resolve those self-aliases — otherwise
      // e.g. `@worker/mini-tool-registry.js` fails with "Does the file exist?".
      "@worker": resolve(__dirname, "../worker/src"),
      "@collab": resolve(__dirname, "../collab/src"),
    },
  },
});
