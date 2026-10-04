// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A model's name on screen: the vendor's name alone, with its variant joined
 * on only when another model in the same list carries the same name.
 */

import { describe, it, expect } from "vitest";

import { modelLabel, modelLabelParts } from "@shared/model-label.js";

/**
 * A catalog entry as far as its name goes.
 * @param display_name - The vendor's name.
 * @param variant - What tells it apart from its siblings, if anything.
 * @returns The entry.
 */
function entry(display_name: string, variant?: string): { display_name: string; variant?: string } {
  return variant === undefined ? { display_name } : { display_name, variant };
}

const GEMINI_T2V = entry("Gemini Omni 1.1 Flash", "Text-to-Video");
const GEMINI_I2V = entry("Gemini Omni 1.1 Flash", "Image-to-Video");
const GEMINI_REF = entry("Gemini Omni 1.1 Flash", "Reference");
const KLING = entry("Kling 3.0 4K");

describe("a model's name on screen", () => {
  it("is the vendor's name alone when nothing else in the list shares it", () => {
    expect(modelLabel(GEMINI_I2V, [GEMINI_I2V, KLING])).toBe("Gemini Omni 1.1 Flash");
  });

  it("joins the variant on when another model in the list has the same name", () => {
    const multiShot = [GEMINI_T2V, GEMINI_I2V, GEMINI_REF, KLING];
    expect(modelLabel(GEMINI_T2V, multiShot)).toBe("Gemini Omni 1.1 Flash Text-to-Video");
    expect(modelLabel(GEMINI_REF, multiShot)).toBe("Gemini Omni 1.1 Flash Reference");
    expect(modelLabel(KLING, multiShot)).toBe("Kling 3.0 4K");
  });

  it("stays the vendor's name for a model with no variant, even beside a namesake", () => {
    const bare = entry("Gemini Omni 1.1 Flash");
    expect(modelLabel(bare, [bare, GEMINI_REF])).toBe("Gemini Omni 1.1 Flash");
  });

  it("is the vendor's name when the model is not in the list it is named against", () => {
    expect(modelLabel(GEMINI_REF, [KLING])).toBe("Gemini Omni 1.1 Flash");
  });
});

describe("a model's name in two parts", () => {
  it("gives the variant apart from the vendor's name where it is joined on", () => {
    expect(modelLabelParts(GEMINI_REF, [GEMINI_T2V, GEMINI_REF])).toEqual({
      name: "Gemini Omni 1.1 Flash",
      variant: "Reference",
    });
  });

  it("gives no variant where the name stands alone", () => {
    expect(modelLabelParts(GEMINI_REF, [GEMINI_REF, KLING])).toEqual({ name: "Gemini Omni 1.1 Flash", variant: undefined });
  });
});
