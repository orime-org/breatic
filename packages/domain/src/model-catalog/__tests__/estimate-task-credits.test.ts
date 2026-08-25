// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * estimateTaskCredits (#1580 #7 credit pre-check) — the estimate the
 * /canvas/tasks route requires a caller's balance to cover before enqueue.
 * The real catalog loads from config YAML; these tests only need the
 * fallback contract and the known-model lookup path, so the catalog is
 * exercised through the same public API the route uses.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  estimateTaskCredits,
  getModelCatalog,
  MIN_TASK_CREDIT_COST,
} from "../model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

// getModelCatalog resolves config YAML via core's injected config; tests
// stand in for the application entry, which is what normally calls initCore.
// 目录一律按 provider 可用性过滤（#1951），而 CI 跑单测时一个 key 都不设 ——
// 不声明这个前提，目录在 CI 上是空的，「返回目录里的 cost_per_call」那一条会
// 走 `if (!priced) return` 提前退出，断言一句不执行而测试照绿。
beforeAll(() => {
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

describe("estimateTaskCredits (#1580 #7)", () => {
  it("falls back to MIN_TASK_CREDIT_COST when no model is specified", () => {
    expect(estimateTaskCredits(undefined)).toBe(MIN_TASK_CREDIT_COST);
  });

  it("falls back to MIN_TASK_CREDIT_COST for an unknown model name", () => {
    expect(estimateTaskCredits("no-such-model-xyz")).toBe(MIN_TASK_CREDIT_COST);
  });

  it("returns the catalog cost_per_call for a known model with a positive cost", () => {
    // Use whatever the real catalog provides — the contract under test is
    // "known model → its own cost_per_call", not a specific model's price.
    const catalog = getModelCatalog();
    const priced = [
      ...catalog.image,
      ...catalog.video,
      ...catalog.audio,
      ...catalog.tts,
      ...catalog.three_d,
      ...catalog.understand,
    ].find((m) => m.cost_per_call > 0);
    if (!priced) {
      // Catalog config without priced models — the fallback contract above
      // already covers this environment.
      expect(estimateTaskCredits("anything")).toBe(MIN_TASK_CREDIT_COST);
      return;
    }
    expect(estimateTaskCredits(priced.name)).toBe(priced.cost_per_call);
  });

  it("MIN_TASK_CREDIT_COST is a positive integer floor", () => {
    expect(Number.isInteger(MIN_TASK_CREDIT_COST)).toBe(true);
    expect(MIN_TASK_CREDIT_COST).toBeGreaterThan(0);
  });
});
