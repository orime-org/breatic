// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A casual product photo turned into a studio hero shot, square, with room for copy. */
export const PRODUCT_HERO_STILL: GenerationTemplate = {
  id: "product-hero-still",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "image", mode: "i2i", model: "gpt-image-2.5-sunburst-edit", params: { aspect_ratio: "1:1", resolution: "4k" } },
  ],
  edges: [],
  inputs: [{ key: "product", type: "image" }],
  steps: [],
  agentNote:
    "a square studio hero shot of the user's product from their own photo, its shape, colours, label and logo unchanged, a key light and a rim light, a foreground, the product and a background, and empty space left for copy added later; it also serves as the first frame of a product video; the user fills in the surface it stands on",
  goal: "product-showcase",
  triggers: {
    asks: ["a product main image", "a white-background product shot"],
    offerWhen: ["the user's product photo is a casual snapshot and they want an ad or a video of it"],
  },
};
