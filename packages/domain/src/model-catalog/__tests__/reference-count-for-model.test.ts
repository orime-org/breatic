// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * violatesReferenceCountForModel (#1735 server reference-count gate) — the
 * model-lookup wrapper the /canvas/tasks route runs BEFORE enqueue. It reads
 * the model's per-param `max_items` off the catalog and rejects a submission
 * that over-fills a capped list param. Exercised against the real config
 * catalog, picking a real model that caps a list param dynamically so the
 * contract — not a specific model — is under test. The rule branches are pinned
 * in reference-count.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  violatesReferenceCountForModel,
  getModelCatalog,
} from "../model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

// 目录一律按 provider 可用性过滤（#1951），而 CI 跑单测时一个 key 都不设 ——
// 不声明这个前提，目录在 CI 上是空的，5 条用例里有 3 条会走「捞不到模型」的
// 分支提前退出，断言一句不执行而测试照绿。
beforeAll(() => {
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

/**
 * A real catalog image model with a positive `max_items` cap on some list param.
 * @returns `{ name, field, limit }` for a capped model, or undefined if none.
 */
function aCappedImageModel(): { name: string; field: string; limit: number } | undefined {
  for (const m of getModelCatalog().image) {
    for (const [field, d] of Object.entries(m.params)) {
      if (typeof d.max_items === "number" && d.max_items >= 1) {
        return { name: m.name, field, limit: d.max_items };
      }
    }
  }
  return undefined;
}

describe("violatesReferenceCountForModel (#1735)", () => {
  it("flags a submission that exceeds a capped list param's max_items", () => {
    const capped = aCappedImageModel();
    if (!capped) return; // catalog without a capped model — nothing to gate here
    const overLimit = Array.from({ length: capped.limit + 1 }, (_, i) => `u${i}`);
    expect(
      violatesReferenceCountForModel(capped.name, { [capped.field]: overLimit }),
    ).toEqual({ field: capped.field, limit: capped.limit, actual: capped.limit + 1 });
  });

  it("passes a submission exactly at the cap", () => {
    const capped = aCappedImageModel();
    if (!capped) return;
    const atLimit = Array.from({ length: capped.limit }, (_, i) => `u${i}`);
    expect(
      violatesReferenceCountForModel(capped.name, { [capped.field]: atLimit }),
    ).toBeNull();
  });

  it("passes a submission well under the cap", () => {
    const capped = aCappedImageModel();
    if (!capped) return;
    expect(
      violatesReferenceCountForModel(capped.name, { [capped.field]: ["one"] }),
    ).toBeNull();
  });

  it("never gates an unknown model (the pre-check is not a model-existence check)", () => {
    expect(violatesReferenceCountForModel("no-such-model-xyz", { images: ["a", "b"] })).toBeNull();
  });

  it("never gates when no model is specified", () => {
    expect(violatesReferenceCountForModel(undefined, { images: ["a", "b"] })).toBeNull();
  });
});
