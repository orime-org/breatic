// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The suites that open real ports and sit through real backoffs: provider's
 * own HTTP module is exercised against Node servers bound to port 0 on
 * loopback, the same way the shared transport is.
 */

import { defineConfig } from "vitest/config";

import base from "./vitest.config.js";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["src/**/*.integration.test.ts"],
    exclude: [],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
