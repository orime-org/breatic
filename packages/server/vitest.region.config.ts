// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The region suite (inner#1955): the integration tests that run the server as
 * a region outside the global one, with the services connected as the role
 * migrate grants there, which cannot read the global tables.
 *
 * Run with: pnpm turbo run test:region
 */

import type {} from "@breatic/integration-tests/provided-context";
import { defineConfig } from "vitest/config";
import integration from "./vitest.integration.config";

// Spread, not mergeConfig: mergeConfig concatenates arrays, which would keep
// every integration file in `include`.
export default defineConfig({
  ...integration,
  test: {
    ...integration.test,
    // Suites that run only the region side; a suite that also plays the
    // global region in-process writes global tables and belongs to test:integration.
    include: ["src/__tests__/integration/region-global-calls.integration.test.ts"],
    globalSetup: [
      "./src/__tests__/integration/payment-configs.ts",
      "./src/__tests__/integration/region-app-role.global.ts",
    ],
    setupFiles: ["@breatic/integration-tests/env", "./src/__tests__/integration/region-app-env.ts"],
  },
});
