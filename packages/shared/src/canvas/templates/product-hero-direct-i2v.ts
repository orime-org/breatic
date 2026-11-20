// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The user's finished product picture as the first frame, set moving. */
export const PRODUCT_HERO_DIRECT_I2V: GenerationTemplate = {
  id: "product-hero-direct-i2v",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "i2v", model: "seedance-2.5-image-to-video", params: { duration: 5, generate_audio: false } },
  ],
  edges: [],
  inputs: [{ key: "picture", type: "image", into: "image" }],
  steps: [],
  agentNote:
    "a 5-second silent video from a product picture the user is already happy with: the picture goes straight into the first frame and only one thing that is not in it moves, the camera locked or pushing in slowly, the label sharp to the end; the user fills in the one thing that moves",
  goal: "product-showcase",
  triggers: {
    asks: ["make a video from this picture", "animate this product image"],
    offerWhen: ["the user's picture is already a finished product main image"],
  },
};
