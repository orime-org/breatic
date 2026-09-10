// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Tests run inside workerd, the runtime this Worker is deployed to.
 *
 * The things worth testing here have no Node equivalent to stand in for them:
 * R2 multipart uploads and `crypto.DigestStream`. A mock of either would be a
 * mock of what we believe the platform does.
 */

import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { resolve } from "node:path";

export default defineWorkersConfig({
  test: {
    // vitest's default is 5s, and one case here deliberately waits two real
    // seconds to tell a re-issued token's window from a carried-forward one.
    // Two seconds of head-room is not enough on a machine running the other
    // eight packages' suites beside this one; every other package in the repo
    // raises this for the same reason.
    testTimeout: 30_000,
    poolOptions: {
      workers: {
        main: "./src/index.ts",
        // Every test here addresses a storage key nothing else uses, so the
        // per-test rollback buys nothing.
        isolatedStorage: false,
        // Everything the Worker runs against is declared here rather than read
        // from `wrangler.toml`: that file is one developer's own copy and is
        // not committed, so a test that needed it would only run on the machine
        // that happened to have one. The names are the code's own —
        // `env.BUCKET` — so a rename that misses this file turns the suite red
        // immediately.
        miniflare: {
          compatibilityDate: "2026-03-10",
          r2Buckets: ["BUCKET"],
          // Values, kept apart from what any deployment holds: an assertion
          // written against a deployment's ports or domain turns every
          // configuration change into a red test about nothing.
          bindings: {
            // The secret wrangler holds in production. Tests sign their own
            // tickets with it, so what they hand the Worker is the same shape
            // our server mints rather than a fixture that only looks like one.
            INGEST_SHARED_SECRET: "test-ingest-secret",
            ALLOWED_ORIGINS: "https://app.test.example",
          },
        },
      },
    },
  },
  resolve: {
    alias: {
      "@ingest": resolve(__dirname, "./src"),
      "@shared": resolve(__dirname, "../shared/src"),
    },
  },
});
