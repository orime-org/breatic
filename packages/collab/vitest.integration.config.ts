// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The suites that hold a real server open for real seconds.
 *
 * They are separated from `vitest.config.ts` because of what they cost the
 * rest of the repo, not because of what they need: `pnpm test` runs every
 * package at once, and a suite that keeps a server alive for a minute decides
 * the timeouts of every other package running beside it. Two of those have
 * already gone red that way while passing on their own.
 *
 * Unlike @breatic/server's integration config, nothing here wants a container.
 * These start their own Hocuspocus on port 0 and talk to it over loopback, so
 * `pnpm --filter @breatic/collab test:integration` needs no Docker, no
 * Postgres and no Redis.
 */

import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    // One process: these bind real ports, and two workers racing for the same
    // one is a failure that says nothing about the code.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // The ping-interval measurement waits out two 30-second periods plus
    // slack. Its own `it` sets 90s; this is the floor under everything here.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      "@collab": resolve(__dirname, "./src"),
    },
  },
});
