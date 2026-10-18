// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1303 §6.3 — the longest side a fill model is known to take, which
 * bounds how far the expand tool lets a picture grow. Read off the real
 * config files: only the real catalog proves the model declares it.
 */

import { describe, it, expect, afterAll } from "vitest";

import { getModelCatalog } from "../model-catalog.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

afterAll(() => {
  restoreProcessEnv();
});

describe("a fill model states the longest side it takes", () => {
  // Measured on WaveSpeed 2026-10-12: 12288×12288 comes back at its own size;
  // past 14142 a side is refused by the upstream's own validation.
  it("gives bria-genfill 12288 pixels", () => {
    useFullCatalog();
    const entry = getModelCatalog().image.find((m) => m.name === "bria-genfill");
    expect(entry?.max_output_side).toBe(12288);
  });

  it("leaves a model that declares none uncapped", () => {
    useFullCatalog();
    const entry = getModelCatalog().image.find((m) => m.name === "bria-eraser");
    expect(entry?.max_output_side).toBeUndefined();
  });
});
