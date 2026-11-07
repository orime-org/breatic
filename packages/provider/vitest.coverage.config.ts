// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Both suites in one run, so the critical paths' coverage counts every test that reaches them: the
 * estimate a run is frozen at, the media runner and its adapters, and the cost lookup in provider.ts.
 * Each of those files must be fully covered (AGENTS.md#critical-paths).
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["./vitest.config.ts", "./vitest.integration.config.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text-summary"],
      include: [
        "src/pricing/estimate.ts",
        "src/pricing/evaluate.ts",
        "src/media/runner.ts",
        "src/media/adapter.ts",
        "src/media/fal/adapter.ts",
        "src/media/sandbase/adapter.ts",
        "src/media/wavespeed/adapter.ts",
        "src/provider.ts",
      ],
      thresholds: { 100: true },
    },
  },
});
