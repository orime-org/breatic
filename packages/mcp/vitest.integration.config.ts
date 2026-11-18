// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Suites that talk to a real Redis, started once for the run by the shared
 * container setup in `@breatic/integration-tests`, so this config needs Docker.
 */

import type {} from "@breatic/integration-tests/provided-context";
import { defineConfig } from "vitest/config";

import base from "./vitest.config.js";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["src/**/*.integration.test.ts"],
    exclude: [],
    globalSetup: ["@breatic/integration-tests/containers"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
