// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import { joinSlotFiles } from "@shared/join-slot-files";
import type { ParamDescriptor } from "@shared/types/model-catalog";

const gptEdit: Readonly<Record<string, ParamDescriptor>> = {
  images: { description: "", default: null, fill: "pool", accepts: "image", type: "list", max_items: 13, mention: "image {n}" },
  style_images: {
    description: "",
    default: null,
    fill: "canvas",
    accepts: "image",
    type: "list",
    max_items: 3,
    optional: true,
    joins: "images",
    prompt_note: "Style references: {list}. Apply their style to the result.",
  },
};

describe("joinSlotFiles", () => {
  it("appends the style files after the mentioned references and names them in the prompt", () => {
    const out = joinSlotFiles(gptEdit, { images: ["a", "b"], style_images: ["s1", "s2", "s3"] }, "Turn image 1 into a poster.");
    expect(out.params.images).toEqual(["a", "b", "s1", "s2", "s3"]);
    expect(out.params.style_images).toBeUndefined();
    expect(out.prompt).toBe(
      "Turn image 1 into a poster. Style references: image 3, image 4 and image 5. Apply their style to the result.",
    );
  });

  it("names a single style file on its own", () => {
    const out = joinSlotFiles(gptEdit, { images: ["a"], style_images: ["s1"] }, "Edit it.");
    expect(out.params.images).toEqual(["a", "s1"]);
    expect(out.prompt).toBe("Edit it. Style references: image 2. Apply their style to the result.");
  });

  it("names two style files with and", () => {
    const out = joinSlotFiles(gptEdit, { style_images: ["s1", "s2"] }, "Edit it.");
    expect(out.params.images).toEqual(["s1", "s2"]);
    expect(out.prompt).toBe("Edit it. Style references: image 1 and image 2. Apply their style to the result.");
  });

  it("leaves params and prompt alone when the slot is empty", () => {
    const params = { images: ["a"], style_images: [] };
    const out = joinSlotFiles(gptEdit, params, "Edit it.");
    expect(out.params).toEqual({ images: ["a"] });
    expect(out.prompt).toBe("Edit it.");
  });

  it("drops entries that are not usable URLs", () => {
    const out = joinSlotFiles(gptEdit, { images: ["a"], style_images: ["", 3, "s1"] }, "Edit it.");
    expect(out.params.images).toEqual(["a", "s1"]);
  });

  it("starts the note without a leading space when the prompt is empty", () => {
    const out = joinSlotFiles(gptEdit, { images: ["a"], style_images: ["s1"] }, "");
    expect(out.prompt).toBe("Style references: image 2. Apply their style to the result.");
  });

  it("passes a model with no joining slot through untouched", () => {
    const krea: Readonly<Record<string, ParamDescriptor>> = {
      style_images: { description: "", default: null, fill: "canvas", accepts: "image", type: "list", max_items: 3, upstream: "reference", item_key: "image" },
    };
    const params = { style_images: ["s1"] };
    const out = joinSlotFiles(krea, params, "A lighthouse.");
    expect(out.params).toEqual(params);
    expect(out.prompt).toBe("A lighthouse.");
  });
});
