// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// One process for the package, as in the other services (rationale in
// packages/web/vitest.config.mts).
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 15_000,
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts"],
  },
  resolve: {
    alias: {
      "@mcp": resolve(__dirname, "./src"),
    },
  },
});
