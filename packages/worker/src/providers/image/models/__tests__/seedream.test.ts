// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import { buildRequest } from "@worker/providers/image/models/seedream.js";

describe("seedream buildRequest — size conversion + image/style merge (#1664)", () => {
  it("converts aspect_ratio + resolution to a pixel size", async () => {
    const [prompt, p] = await buildRequest("a cat", "seedream-5.0-lite", {
      aspect_ratio: "16:9",
      resolution: "2k",
    });
    expect(prompt).toBe("a cat");
    expect(p.size).toBe("2048*1152");
    expect("aspect_ratio" in p).toBe(false);
    expect("resolution" in p).toBe(false);
  });

  it("sends no image field and no scaffold when no images ride the request", async () => {
    const [prompt, p] = await buildRequest("a cat", "seedream-5.0-lite", {
      aspect_ratio: "1:1",
      resolution: "1k",
    });
    expect("image" in p).toBe(false);
    expect(prompt).toBe("a cat");
  });

  it("maps a style image into the official `image` field + appends the style scaffold", async () => {
    // Official ModelArk field is `image` (docs 1541523 — the API has no
    // image_urls); style role is conveyed by prompt prose (docs 1829186).
    const [prompt, p] = await buildRequest("a cat", "seedream-5.0-lite", {
      aspect_ratio: "1:1",
      resolution: "1k",
      style_images: ["https://cdn/style.png"],
    });
    expect(p.image).toEqual(["https://cdn/style.png"]);
    expect("style_images" in p).toBe(false);
    expect("image_urls" in p).toBe(false);
    expect(prompt).toContain("a cat");
    expect(prompt).toContain("style reference");
    expect(prompt).toContain("do not copy its subjects");
  });

  it("merges content images FIRST + style LAST, scaffolding with index references", async () => {
    // The officially documented cross-image pattern: "Apply the style of
    // Image 2 to Image 1" — content first, style last, index-referenced.
    const [prompt, p] = await buildRequest("edit it", "seedream-5.0-lite", {
      aspect_ratio: "1:1",
      resolution: "1k",
      images: ["https://cdn/content.png"],
      style_images: ["https://cdn/style.png"],
    });
    expect(p.image).toEqual(["https://cdn/content.png", "https://cdn/style.png"]);
    expect("images" in p).toBe(false);
    expect(prompt).toContain("Apply the style of image 2");
    expect(prompt).toContain("image 1 is the content input");
  });

  it("passes content images through the `image` field without a scaffold when no style rides", async () => {
    const [prompt, p] = await buildRequest("edit it", "seedream-5.0-lite", {
      aspect_ratio: "1:1",
      resolution: "1k",
      images: ["https://cdn/content.png"],
    });
    expect(p.image).toEqual(["https://cdn/content.png"]);
    expect(prompt).toBe("edit it");
  });
});
