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
