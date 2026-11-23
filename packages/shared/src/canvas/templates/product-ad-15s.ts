// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 15-second vertical product ad: a lifestyle still of the product in use, then the video built on it. */
export const PRODUCT_AD_15S: GenerationTemplate = {
  id: "product-ad-15s",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 15, generate_audio: true } },
    { key: "still", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "9:16" } },
  ],
  edges: [{ from: "still", to: "result", into: "pool" }],
  inputs: [
    { key: "product", type: "image", feeds: ["still", "result"] },
    { key: "person", type: "image", feeds: ["still", "result"], optional: true },
  ],
  steps: [],
  agentNote:
    "a 15-second vertical ad for the user's product in four timed parts (a hook, the product shown in 3 cuts, someone using it, a clean end frame with empty space for text added later), the product's shape, colours, label and logo kept as in the photo; the lifestyle still is generated first and goes into the video's pool; the person is optional and the model casts someone who fits when it is left empty; the user fills in the hook, the scene and the selling point; the still runs on nano-banana-pro-edit-ultra, which kept the product's proportions and cap in our real runs where gpt-image-2.5-sunburst-edit changed them",
  goal: "ecommerce",
  triggers: {
    asks: ["a product ad", "a video to sell my product"],
    offerWhen: ["the user adds a photo of a product and mentions promoting or selling it"],
  },
};
