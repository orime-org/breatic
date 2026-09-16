// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Two projects, split by which runtime a test needs.
 *
 * Almost everything here runs inside workerd, the runtime this Worker is
 * deployed to, because the things worth testing have no Node equivalent to
 * stand in for them: R2 multipart uploads and `crypto.DigestStream`. A mock of
 * either would be a mock of what we believe the platform does.
 *
 * A test that reaches for neither belongs on Node, and says so by ending in
 * `.node.test.ts`. What sends it there is that starting an isolate costs time
 * the pool schedules rather than the test spends: `media-read-deadline` waits
 * on a 20ms timer, and under the pool its file was measured at 95ms, 5850ms
 * and 35788ms on three green CI runs of main. A budget cannot be written
 * against a quantity that moves by two orders of magnitude between runs, so
 * the tests whose subject is a duration are read off Node's clock.
 */

import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/** Where both projects find this package's and shared's sources. */
const alias = {
  "@ingest": resolve(__dirname, "./src"),
  "@shared": resolve(__dirname, "../shared/src"),
};

/** Tests named for Node, which the workers project leaves alone. */
const NODE_TESTS = "src/**/__tests__/**/*.node.test.ts";

const workers = defineWorkersProject({
  test: {
    name: "workers",
    exclude: ["**/node_modules/**", NODE_TESTS],
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
          // Bound, and deliberately with no image behind it. Declaring one
          // would make every run of this suite need Docker and a built image
          // for the sake of a step that is best-effort by design — while
          // leaving the binding out would let a finish that never reaches a
          // container pass for the ordinary case. What the tests exercise is
          // therefore the degraded one: the container refuses to construct
          // without an image, the read is written down and answers as nothing
          // found, and the upload still stands. That the container itself
          // works is measured against the real image.
          durableObjects: {
            MEDIA: { className: "MediaContainer", useSQLite: true },
          },
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
  resolve: { alias },
});

const node = defineConfig({
  test: {
    name: "node",
    include: [NODE_TESTS],
    // Node's own clock decides these, so the default 5s is head-room enough.
  },
  resolve: { alias },
});

export default defineConfig({ test: { projects: [workers, node] } });
