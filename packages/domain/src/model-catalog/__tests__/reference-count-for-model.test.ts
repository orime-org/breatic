// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

/**
 * A cap that moves with another param (#1928), read off the real catalog.
 *
 * `kling-o3-pro-ref` takes 7 reference images alone and 4 alongside a
 * reference video. The route runs this gate before enqueue precisely so the
 * user hears about it rather than the worker silently truncating, and the
 * number it enforces has to come from the same rule the panel and the worker
 * read. Exercised against the shipped yaml, so a catalog that stopped
 * declaring the conditional cap reds here too.
 */
describe("violatesReferenceCountForModel and a cap that moves (#1928)", () => {
  /**
   * A real catalog model whose list param states a conditional cap.
   * @returns `{ name, field, plain, conditional, on }`, or undefined if none.
   */
  function aConditionallyCappedModel():
    | { name: string; field: string; plain: number; conditional: number; on: string }
    | undefined {
    for (const m of getModelCatalog().video) {
      for (const [field, d] of Object.entries(m.params)) {
        const when = d.max_items_when_present;
        const plain = d.max_items;
        if (typeof plain !== "number" || !when) continue;
        const [on, conditional] = Object.entries(when)[0] ?? [];
        if (typeof on === "string" && typeof conditional === "number") {
          return { name: m.name, field, plain, conditional, on };
        }
      }
    }
    return undefined;
  }

  /**
   * Builds a list of the given length.
   * @param n - How many entries.
   * @returns Placeholder urls.
   */
  function urls(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `u${i}`);
  }

  it("the catalog states one, so this suite is not vacuous", () => {
    // Every case below returns early without it; without this line the whole
    // describe would pass while asserting nothing.
    const m = aConditionallyCappedModel();
    expect(m).toBeDefined();
    expect(m!.conditional).toBeLessThan(m!.plain);
  });

  it("allows the plain cap while the other param carries nothing", () => {
    const m = aConditionallyCappedModel();
    if (!m) return;
    expect(
      violatesReferenceCountForModel(m.name, { [m.field]: urls(m.plain) }),
    ).toBeNull();
  });

  it("rejects that same count once the other param carries a value", () => {
    const m = aConditionallyCappedModel();
    if (!m) return;
    expect(
      violatesReferenceCountForModel(m.name, {
        [m.field]: urls(m.plain),
        [m.on]: "https://cdn.example/clip.mp4",
      }),
    ).toEqual({ field: m.field, limit: m.conditional, actual: m.plain });
  });

  it("allows a count within the lower cap alongside that value", () => {
    const m = aConditionallyCappedModel();
    if (!m) return;
    expect(
      violatesReferenceCountForModel(m.name, {
        [m.field]: urls(m.conditional),
        [m.on]: "https://cdn.example/clip.mp4",
      }),
    ).toBeNull();
  });
});
