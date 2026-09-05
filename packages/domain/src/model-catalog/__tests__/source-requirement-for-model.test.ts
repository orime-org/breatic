// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * violatesSourceRequirementForModel (#1675 server execute gate) — the model-
 * lookup wrapper the /canvas/tasks route runs BEFORE enqueue. It reads
 * the model's catalog `sourcesByMode` and applies the same rule the frontend
 * gets on the wire. Exercised against the real config catalog, picking a real
 * source-requiring model and a real source-less (t2i-capable) model dynamically
 * so the contract — not a specific model — is under test. The rule branches
 * themselves are pinned in source-requirement.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  violatesSourceRequirementForModel,
  getModelCatalog,
} from "../model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

// 目录一律按 provider 可用性过滤（#1951），而 CI 跑单测时一个 key 都不设 ——
// 不声明这个前提，目录在 CI 上是空的，8 条用例里有 6 条会走「捞不到模型」的
// 分支提前退出，断言一句不执行而测试照绿。
beforeAll(() => {
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

/**
 * A real catalog image model whose EVERY mode needs a source (so the gate
 * fires), and which reads that source from `images`.
 *
 * The second half arrived with #1960: the gate now asks whether the MODEL
 * declares the field a payload uses, so a model reading its source from
 * `image` is not one an `images` payload satisfies. Picking any gated model
 * and handing it `images` assumed one spelling for all of them, which was
 * only true while the gate ignored declarations.
 * @returns The model name, or undefined if the catalog has none.
 */
function aGatedImageModel(): string | undefined {
  return getModelCatalog().image.find((m) => {
    const modes = Object.values(m.sourcesByMode);
    return (
      modes.length > 0 &&
      modes.every((s) => s.length > 0) &&
      Object.keys(m.params ?? {}).includes("images")
    );
  })?.name;
}

/**
 * A real catalog image model that can run source-less (has a t2i-like mode).
 * @returns The model name, or undefined if the catalog has none.
 */
function aSourcelessImageModel(): string | undefined {
  return getModelCatalog().image.find((m) =>
    Object.values(m.sourcesByMode).some((s) => s.length === 0),
  )?.name;
}

describe("violatesSourceRequirementForModel (#1675)", () => {
  it("flags a source-requiring model with NO images param as a violation", () => {
    const model = aGatedImageModel();
    if (!model) return; // catalog without such models — nothing to gate here
    expect(violatesSourceRequirementForModel(model, {})).toBe(true);
  });

  it("flags a source-requiring model with an EMPTY images array as a violation", () => {
    const model = aGatedImageModel();
    if (!model) return;
    expect(violatesSourceRequirementForModel(model, { images: [] })).toBe(true);
  });

  it("passes a source-requiring model that carries at least one source image", () => {
    const model = aGatedImageModel();
    if (!model) return;
    expect(
      violatesSourceRequirementForModel(model, { images: ["https://cdn/x.png"] }),
    ).toBe(false);
  });

  it("never gates a source-less (t2i-capable) model, even with no images", () => {
    const model = aSourcelessImageModel();
    if (!model) return;
    expect(violatesSourceRequirementForModel(model, {})).toBe(false);
  });

  it("never gates an unknown model (the pre-check is not a model-existence check)", () => {
    expect(violatesSourceRequirementForModel("no-such-model-xyz", {})).toBe(false);
  });

  it("never gates when no model is specified", () => {
    expect(violatesSourceRequirementForModel(undefined, {})).toBe(false);
  });

  it("does not accept a WRONG source type — an image model given only a video url still violates", () => {
    const model = aGatedImageModel();
    if (!model) return;
    // video_url carries a video source, not the image this model needs.
    expect(
      violatesSourceRequirementForModel(model, { video_url: "https://cdn/v.mp4" }),
    ).toBe(true);
  });

  it("does not accept a malformed non-array `images` (a crafted bare string) — still a violation", () => {
    const model = aGatedImageModel();
    if (!model) return;
    // `params` is unvalidated on the wire; a bare string in the array-shaped
    // `images` field is a guaranteed-failure input, so the gate rejects it.
    expect(
      violatesSourceRequirementForModel(model, { images: "https://cdn/x.png" }),
    ).toBe(true);
  });
});

/**
 * One vendor's spelling does not satisfy another model's requirement (#1960).
 *
 * The audio row of the carrier table holds six field names, because six
 * vendors spell the same thing six ways, and four modes read that one row.
 * The gate asks a second question of every field — does THIS model declare it
 * — and that question is the only thing standing between a payload carrying
 * `song` and the talking-head gate, whose transport reads `audio_url` and
 * would build a request with no audio at all.
 */
describe("a field this model does not declare is not a source it can use", () => {
  /**
   * A real catalog model needing an audio source and NOTHING else, reading it
   * under a name other than `song`.
   *
   * Audio alone, so the second case can satisfy the whole requirement with one
   * field — a model needing an image as well would violate for the image.
   * @returns The model name, or undefined when the catalog serves none.
   */
  function anAudioGatedModelNotReadingSong(): string | undefined {
    const catalog = getModelCatalog();
    for (const entry of Object.values(catalog).flatMap((b) =>
      Array.isArray(b) ? b : [],
    )) {
      const byMode: Record<string, string[]> = entry.sourcesByMode ?? {};
      const modes = Object.values(byMode);
      if (modes.length === 0) continue;
      if (modes.some((sources) => sources.length === 0)) continue;
      const required = new Set(modes.flat());
      if (required.size !== 1 || !required.has("audio")) continue;
      const declared = new Set(Object.keys(entry.params ?? {}));
      if (declared.has("song")) continue;
      if (!["audio", "audio_url", "ref_audio_url"].some((f) => declared.has(f))) {
        continue;
      }
      return entry.name;
    }
    return undefined;
  }

  it("refuses a payload whose only audio field belongs to another vendor", () => {
    const model = anAudioGatedModelNotReadingSong();
    expect(model, "the catalog serves no audio-gated model to test with").toBeTruthy();
    if (!model) return;
    expect(
      violatesSourceRequirementForModel(model, { song: "https://cdn/s.mp3" }),
    ).toBe(true);
  });

  it("accepts the same payload under the name that model does declare", () => {
    const model = anAudioGatedModelNotReadingSong();
    if (!model) return;
    const catalog = getModelCatalog();
    const entry = Object.values(catalog)
      .flatMap((b) => (Array.isArray(b) ? b : []))
      .find((m) => m.name === model);
    const field = ["audio", "audio_url", "ref_audio_url"].find((f) =>
      Object.keys(entry?.params ?? {}).includes(f),
    );
    expect(field).toBeTruthy();
    expect(
      violatesSourceRequirementForModel(model, { [field!]: "https://cdn/s.mp3" }),
    ).toBe(false);
  });
});
