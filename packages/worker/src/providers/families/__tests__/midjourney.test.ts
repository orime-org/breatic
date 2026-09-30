// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Midjourney's style reference is a list on our side (the canvas slot writes
 * one) and a single url upstream (`sref`).
 */

import { describe, it, expect } from "vitest";

import midjourney from "@worker/providers/families/midjourney.js";

describe("midjourney family", () => {
  it("covers the catalog's Midjourney", () => {
    expect([...midjourney.MODELS]).toEqual(["midjourney"]);
  });

  it("sends the one style image as sref and keeps the list out of the body", async () => {
    const { prompt, fields } = await midjourney.prepare("a fox", {
      style_images: ["https://cdn.test/style.png"],
    });

    expect(prompt).toBe("a fox");
    expect(fields).toEqual({ sref: "https://cdn.test/style.png" });
    expect(midjourney.CONSUMES.has("style_images")).toBe(true);
  });

  it("sends no sref without a style image", async () => {
    expect((await midjourney.prepare("a fox", { style_images: null })).fields).toEqual({});
    expect((await midjourney.prepare("a fox", { style_images: [] })).fields).toEqual({});
  });
});
