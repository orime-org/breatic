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
