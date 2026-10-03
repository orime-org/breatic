/**
 * Integration suites that span more than one service.
 *
 * A test lives here when it drives code from two or more of server, worker
 * and collab in one run; a test of a single package lives in that package.
 * The services are read from source by path, so this package declares none of
 * them: server and collab depend on it for the shared container setup below,
 * and declaring them back would close a cycle.
 *
 * Run with: pnpm turbo run test:integration --filter=@breatic/integration-tests
 */

import type {} from "@breatic/integration-tests/provided-context";
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["@breatic/integration-tests/containers"],
    setupFiles: ["@breatic/integration-tests/env"],
    // Single fork: one worker process, one container set, no port conflicts.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      // The services' sources, and the aliases those sources use for
      // themselves and for the libraries they read from source.
      "@integration-tests": resolve(__dirname, "./src"),
      "@server": resolve(__dirname, "../server/src"),
      "@worker": resolve(__dirname, "../worker/src"),
      "@collab": resolve(__dirname, "../collab/src"),
      "@domain": resolve(__dirname, "../domain/src"),
    },
  },
});
