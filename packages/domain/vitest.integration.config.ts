// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type {} from "../integration-tests/src/test-utils/provided-context.d.ts";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testNamePattern: /^(?!.*@needs-)/,
    // Global setup paths are resolved before Vite aliases. Reuse the shared
    // implementation by its actual path without adding a circular package edge.
    globalSetup: [resolve(__dirname, "../integration-tests/src/test-utils/containers.ts")],
    setupFiles: [resolve(__dirname, "../integration-tests/src/test-utils/env.ts")],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: { alias: { "@domain": resolve(__dirname, "./src") } },
});
