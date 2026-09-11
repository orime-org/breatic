// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The suites that open real ports and sit through real backoffs.
 *
 * The HTTP layer takes no injected fetch and no injected clock, so there is
 * nothing in it to substitute: every case starts a server, sends bytes and
 * waits out whatever the retry policy says to wait. That is the point — a
 * double for the network only ever asserts what the same hand wrote — and it
 * is also why they are separated here.
 *
 * `pnpm test` runs every package at once, and a suite that spends 46 seconds
 * holding servers open decides the timeouts of every other package running
 * beside it. Two suites in other packages have already gone red that way
 * while passing on their own.
 *
 * Nothing here wants a container: the servers are Node's own, bound to port 0
 * on loopback.
 */

import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    globals: true,
    // One process: these bind real ports, and two workers racing for the same
    // one is a failure that says nothing about the code.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // A case that exercises a replay really does back off, and the ceiling on
    // one wait is 60 seconds.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "./src"),
    },
  },
});
