// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 3D-render look of the product, then a video where it breaks into glowing particles and reforms. */
export const PRODUCT_PARTICLE_REVEAL: GenerationTemplate = {
  id: "product-particle-reveal",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "i2v", model: "seedance-2.5-image-to-video", params: { duration: 6, generate_audio: true } },
    { key: "render", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9" } },
  ],
  edges: [{ from: "render", to: "result", into: "image" }],
  inputs: [{ key: "product", type: "image", feeds: ["render"] }],
  steps: [],
  agentNote:
    "a 6-second widescreen tech reveal: the user's product is first re-rendered as a polished 3D render on black and picked into the video's first frame; in the video it breaks into glowing particles, the particles swirl and reform it exactly as it was, then the camera circles it while it does one small action; the user fills in the particle colour and the small action",
  goal: "product-showcase",
  triggers: {
    asks: ["a tech-style product reveal", "a particle effect for my product"],
    offerWhen: ["the user is launching a tech or luxury product"],
  },
};
