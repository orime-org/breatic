// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Both suites in one run, so the critical paths' coverage counts every test that reaches them: the
 * estimate a run is frozen at and the formula evaluator under it, routing, the media runner and its
 * adapters, and every reader of an actual cost (WaveSpeed's billing, the understand adapters and the shared
 * understand exchange in understand/adapter.ts, which stamps the send moment an understand call is priced at and
 * builds its token buckets, the LLM switch, the price-table cost of every direct LLM call in llm.ts and the cost
 * lookup in provider.ts). Each of those files must be fully covered, and a failure
 * lists the file and its uncovered lines (AGENTS.md#critical-paths).
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["./vitest.config.ts", "./vitest.integration.config.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text-summary", ["text", { skipFull: true }]],
      include: [
        "src/pricing/estimate.ts",
        "src/pricing/evaluate.ts",
        "src/media/runner.ts",
        "src/media/adapter.ts",
        "src/media/fal/adapter.ts",
        "src/media/sandbase/adapter.ts",
        "src/media/wavespeed/adapter.ts",
        "src/media/wavespeed/billing.ts",
        "src/routing/decide.ts",
        "src/routing/route.ts",
        "src/routing/try-in-order.ts",
        "src/llm/llm.ts",
        "src/llm/switching.ts",
        "src/llm/understand/adapter.ts",
        "src/llm/understand/google.ts",
        "src/llm/understand/openrouter.ts",
        "src/provider.ts",
      ],
      thresholds: { 100: true, perFile: true },
    },
  },
});
