// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * violatesSourceRequirementForModel (#1675 server execute gate) — the model-
 * lookup wrapper the /canvas/tasks route runs BEFORE enqueue/billing. It reads
 * the model's catalog `sourcesByMode` and applies the same rule the frontend
 * gets on the wire. Exercised against the real config catalog, picking a real
 * source-requiring model and a real source-less (t2i-capable) model dynamically
 * so the contract — not a specific model — is under test. The rule branches
 * themselves are pinned in source-requirement.test.ts.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { initCore } from "@breatic/core";
import {
  violatesSourceRequirementForModel,
  getModelCatalog,
} from "../model-catalog.js";

beforeAll(() => {
  initCore(process.env);
});

/**
 * A real catalog image model whose EVERY mode needs a source (so the gate fires).
 * @returns The model name, or undefined if the catalog has none.
 */
function aGatedImageModel(): string | undefined {
  return getModelCatalog().image.find((m) => {
    const modes = Object.values(m.sourcesByMode);
    return modes.length > 0 && modes.every((s) => s.length > 0);
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
});
