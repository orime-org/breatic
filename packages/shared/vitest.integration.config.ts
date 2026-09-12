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

import base from "./vitest.config.js";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["src/**/*.integration.test.ts"],
    // The base excludes exactly these. Spreading overwrites rather than
    // concatenating, so the list has to be cleared by hand.
    exclude: [],
    // Everything else — the path alias, one process for the whole package —
    // comes from the base, so an alias added there reaches both suites.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
