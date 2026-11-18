// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The product in two states as first and end frame, the video only the continuous change between them. */
export const PRODUCT_STATE_CHANGE: GenerationTemplate = {
  id: "product-state-change",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "first_last", model: "seedance-2.5-image-to-video", params: { duration: 5, generate_audio: true } },
    { key: "before", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "1:1" } },
    { key: "after", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "1:1" } },
  ],
  edges: [
    { from: "before", to: "after", into: "pool" },
    { from: "before", to: "result", into: "image" },
    { from: "after", to: "result", into: "end_image" },
  ],
  inputs: [{ key: "product", type: "image", feeds: ["before"] }],
  steps: [],
  agentNote:
    "a 5-second square before-and-after of the user's product: a picture of the product in its starting state is generated from their photo, and a picture of it in its other state (open, folded, another colour) is edited from that one so the camera, surface and light stay; the two become the video's first and end frame, and the video is one continuous change between them carried by one thing throughout, such as a hand; the user fills in the surface, the other state and what carries the change",
  goal: "product-showcase",
  triggers: {
    asks: ["show my product going from one state to another", "a before and after of my product"],
    offerWhen: ["the user wants to show what their product does before and after"],
  },
};
