// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Resolution tiers read with a capital K (inner#1304), as the industry writes
 * them; the values WaveSpeed is sent stay as the catalog spells them.
 */
import { describe, it, expect } from "vitest";

import { MODALITIES, getFullModelConfig } from "../model-catalog.js";

describe("resolution tiers on screen", () => {
  it("labels every k tier with a capital K and keeps the value sent", () => {
    const unlabelled: string[] = [];
    let tiers = 0;
    for (const modality of MODALITIES) {
      for (const model of getFullModelConfig(modality).models) {
        for (const [name, spec] of Object.entries(model.params ?? {})) {
          for (const value of spec.values ?? []) {
            if (typeof value !== "string" || !/^[\d.]+k$/.test(value)) continue;
            tiers += 1;
            if (spec.value_labels?.[value] !== value.toUpperCase()) unlabelled.push(`${model.name}.${name}=${value}`);
          }
        }
      }
    }
    expect(unlabelled).toEqual([]);
    expect(tiers).toBeGreaterThan(0);
  });
});
