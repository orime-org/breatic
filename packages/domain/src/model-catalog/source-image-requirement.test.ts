// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * violatesSourceImageRequirement (#1675 server execute gate) — the check the
 * /canvas/tasks route runs BEFORE enqueue/billing so a model that needs a
 * source image (i2i / edit) is never submitted with an empty `params.images`.
 * Exercised against the real config catalog (same pattern as
 * estimate-task-credits.test), picking a real i2i/edit and a real t2i model
 * dynamically so the contract — not a specific model — is under test.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { initCore } from "@breatic/core";
import { requiresSourceImage } from "@breatic/shared";
import {
  violatesSourceImageRequirement,
  getModelCatalog,
} from "./model-catalog.js";

beforeAll(() => {
  initCore(process.env);
});

/**
 * The name of a real catalog image model whose mode needs a source image.
 * @returns An i2i/edit model name, or undefined if the catalog has none.
 */
function anI2iModel(): string | undefined {
  return getModelCatalog().image.find((m) => requiresSourceImage(m.mode))?.name;
}

/**
 * The name of a real catalog image model that generates from scratch (t2i).
 * @returns A t2i model name, or undefined if the catalog has none.
 */
function aT2iModel(): string | undefined {
  return getModelCatalog().image.find((m) => !requiresSourceImage(m.mode))?.name;
}

describe("violatesSourceImageRequirement (#1675)", () => {
  it("flags an i2i/edit model with NO images param as a violation", () => {
    const model = anI2iModel();
    if (!model) return; // catalog without i2i models — nothing to gate here
    expect(violatesSourceImageRequirement(model, {})).toBe(true);
  });

  it("flags an i2i/edit model with an EMPTY images array as a violation", () => {
    const model = anI2iModel();
    if (!model) return;
    expect(violatesSourceImageRequirement(model, { images: [] })).toBe(true);
  });

  it("passes an i2i/edit model that carries at least one source image", () => {
    const model = anI2iModel();
    if (!model) return;
    expect(
      violatesSourceImageRequirement(model, { images: ["https://cdn/x.png"] }),
    ).toBe(false);
  });

  it("never gates a t2i model, even with no images (generates from scratch)", () => {
    const model = aT2iModel();
    if (!model) return;
    expect(violatesSourceImageRequirement(model, {})).toBe(false);
  });

  it("never gates an unknown model (the pre-check is not a model-existence check)", () => {
    expect(violatesSourceImageRequirement("no-such-model-xyz", {})).toBe(false);
  });

  it("never gates when no model is specified", () => {
    expect(violatesSourceImageRequirement(undefined, {})).toBe(false);
  });

  it("treats a non-array images param as absent (malformed input is a violation for i2i)", () => {
    const model = anI2iModel();
    if (!model) return;
    expect(
      violatesSourceImageRequirement(model, { images: "not-an-array" }),
    ).toBe(true);
  });
});
