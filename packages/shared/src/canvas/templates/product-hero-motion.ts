// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A hero shot of the product first, then one change of light or material that makes it move. */
export const PRODUCT_HERO_MOTION: GenerationTemplate = {
  id: "product-hero-motion",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "i2v", model: "seedance-2.5-image-to-video", params: { duration: 5, generate_audio: false } },
    { key: "still", role: "generate", type: "image", mode: "i2i", model: "gpt-image-2.5-sunburst-edit", params: { aspect_ratio: "1:1" } },
  ],
  edges: [{ from: "still", to: "result", into: "image" }],
  inputs: [{ key: "product", type: "image", feeds: ["still"] }],
  steps: [],
  agentNote:
    "a 5-second silent square product loop: a studio hero shot is generated from the user's photo first and picked into the video's first frame, then one thing changes (light sweeping over it, steam, a drop running down) while the camera stays locked or pushes in slowly and the label stays sharp; the user fills in the surface and the one thing that moves",
  goal: "product-showcase",
  triggers: {
    asks: ["make my product move", "a motion main image"],
    offerWhen: ["the user already has a product main image and wants a video of it"],
  },
};
