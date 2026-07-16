// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import { buildRequest } from "@worker/providers/image/models/midjourney.js";

describe("midjourney buildRequest — style_images → sref (#1664)", () => {
  it("maps the unified style_images param to the endpoint's sref field", async () => {
    const [prompt, p] = await buildRequest("a castle", "midjourney-v7", {
      aspect_ratio: "16:9",
      stylize: 100,
      style_images: ["https://cdn/style.png"],
    });
    expect(prompt).toBe("a castle");
    expect(p.sref).toBe("https://cdn/style.png");
    expect("style_images" in p).toBe(false);
  });

  it("sends no sref when no style image is picked", async () => {
    const [, p] = await buildRequest("a castle", "midjourney-v7", {
      aspect_ratio: "16:9",
    });
    expect("sref" in p).toBe(false);
  });

  it("still strips the resolution param (endpoint does not accept it)", async () => {
    const [, p] = await buildRequest("a castle", "midjourney-v7", {
      resolution: "2k",
      aspect_ratio: "16:9",
    });
    expect("resolution" in p).toBe(false);
    expect(p.aspect_ratio).toBe("16:9");
  });
});
