// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Vitest configuration for integration tests.
 *
 * Separate from vitest.config.ts (unit tests) — integration tests:
 *   - require real Docker containers (PostgreSQL + Redis via testcontainers)
 *   - take 30–120 seconds to run (container boot + migration + E2E flow)
 *   - must NOT run as part of the default `pnpm test` CI step
 *
 * Run with: pnpm exec turbo run test:integration --filter=@breatic/server
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
    // A case that reaches a real outside service carries a `@needs-<service>`
    // tag at the end of its name (docs/TEST-MANDATE.md §2.2). The default run
    // leaves every tagged case out; vitest reports each one as skipped, so the
    // summary's skip count says what this green did not cover. A sub-gate is
    // run on purpose with `-t @needs-<service>`, which replaces this pattern.
    testNamePattern: /^(?!.*@needs-)/,
    // globalSetup lays down the payment configs only this package's suites
    // read — first, because it is cheap and a fixture that cannot be copied
    // fails the run before a minute goes into pulling images — then starts
    // the testcontainers BEFORE any test module is imported.
    globalSetup: [
      "./src/__tests__/integration/payment-configs.ts",
      "@breatic/integration-tests/containers",
    ],
    // setupFiles runs inside the worker process. Re-applies env vars from globalSetup.
    setupFiles: ["@breatic/integration-tests/env"],
    // One file at a time, each in a fresh fork, all against the one container
    // set globalSetup started. A single fork for every file runs out of heap:
    // `singleFork` turns off module isolation, every file re-evaluates the
    // server's source, and the copies stay reachable, so the heap grows by
    // about 19 MB a file (measured: 162 MB at the first of 193 files, 3880 MB
    // at the last, against a 4288 MB default limit). A fresh fork per file
    // peaks at 367 MB; the run takes about twice as long.
    pool: "forks",
    fileParallelism: false,
    poolOptions: {
      forks: {
        singleFork: false,
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
