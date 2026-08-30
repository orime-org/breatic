// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Tests run inside workerd, the runtime this Worker is deployed to.
 *
 * The things worth testing here have no Node equivalent to stand in for them:
 * a Durable Object that keeps state between requests, R2 multipart uploads,
 * and `crypto.DigestStream`. A mock of any of them would be a mock of what we
 * believe the platform does.
 */

import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { resolve } from "node:path";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        // Every test here addresses a storage key nothing else uses, so the
        // per-test rollback buys nothing — and the runner cannot always undo
        // it: a test that reaches one Durable Object instance twice leaves a
        // SQLite -shm file behind, which the rollback asserts on
        // (cloudflare/workers-sdk#11031).
        isolatedStorage: false,
        miniflare: {
          bindings: {
            // The secret wrangler holds in production. Tests sign their own
            // tickets with it, so what they hand the Worker is the same shape
            // our server mints rather than a fixture that only looks like one.
            INGEST_SHARED_SECRET: "test-ingest-secret",
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
