// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Seedream 5.5's transparent background toggle on WaveSpeed (inner#1809). The
 * endpoint's own `background` default, auto, lets the model choose a
 * transparent picture from the prompt, so the toggle sends opaque when off and
 * the off state stays solid (https://wavespeed.ai/models/bytedance/seedream-v5.5).
 */

import { describe, expect, it } from "vitest";
import { catalog, resolvedParams, shipped } from "../../../config/__tests__/shipped.js";
import { buildBody } from "../../body.js";

const IMAGE = "https://cdn.example/image/pet.png";

/**
 * The WaveSpeed body a run of this model sends, its params resolved as the application resolves them.
 * @param model - The model.
 * @param given - The run's params.
 * @returns The body.
 * @throws {Error} When the model is not in the catalog or has no WaveSpeed binding.
 */
function bodyOf(model: string, given: Record<string, unknown>, prompt = "a cat"): Record<string, unknown> {
  const entry = catalog().models.find((m) => m.name === model);
  const binding = shipped().media.models[model]?.upstreams.find((b) => b.upstream === "wavespeed");
  if (!entry || !binding) throw new Error(`${model} has no catalog entry or WaveSpeed binding`);
  return buildBody(binding, { params: resolvedParams(entry, given), prompt });
}

describe("Seedream 5.5 edit", () => {
  it("sends the images and writes a reference to one as the upstream's image n", () => {
    const body = bodyOf("seedream-v5.5-edit", { images: [IMAGE, IMAGE] }, "put the hat from {{ref:images:2}} on the cat");
    expect(body).toMatchObject({ images: [IMAGE, IMAGE], prompt: "put the hat from image 2 on the cat" });
  });

  it("sends no style image, which the edit keeps out of the upstream's ten", () => {
    expect(bodyOf("seedream-v5.5-edit", { images: [IMAGE], style_images: [IMAGE] })).not.toHaveProperty("style_images");
  });
});

describe("Seedream 5.5 background", () => {
  it.each([
    ["seedream-v5.5-text-to-image", {}],
    ["seedream-v5.5-edit", { images: [IMAGE] }],
  ])("%s asks for transparent when on and opaque when off or left alone", (model, base) => {
    expect(bodyOf(model, { ...base, transparency: true }).background).toBe("transparent");
    expect(bodyOf(model, { ...base, transparency: false }).background).toBe("opaque");
    expect(bodyOf(model, base).background).toBe("opaque");
    expect(bodyOf(model, base)).not.toHaveProperty("transparency");
  });
});
