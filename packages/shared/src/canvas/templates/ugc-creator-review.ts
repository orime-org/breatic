// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 15-second vertical review of the user's product by a creator holding a phone, in their own words. */
export const UGC_CREATOR_REVIEW: GenerationTemplate = {
  id: "ugc-creator-review",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 15, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "creator", type: "image" },
    { key: "product", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 15-second vertical handheld phone video in which the creator from the user's photo talks about the product from the other photo, the creator and the product each kept as in their photo; the user fills in what the creator says, each line no longer than 8 English words; it ends on the product alone, then the creator holding it to the lens",
  goal: "ecommerce",
  triggers: {
    asks: ["a creator review video", "an unboxing review by an influencer", "a UGC ad"],
    offerWhen: ["the user wants a product video that feels real and recommended by a person"],
  },
};
