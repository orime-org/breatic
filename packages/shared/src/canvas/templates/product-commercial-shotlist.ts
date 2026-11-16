// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 12-second widescreen premium product film, written as a timed shot list. */
export const PRODUCT_COMMERCIAL_SHOTLIST: GenerationTemplate = {
  id: "product-commercial-shotlist",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "16:9", duration: 12, generate_audio: true } },
  ],
  edges: [],
  inputs: [{ key: "product", type: "image" }],
  steps: [],
  agentNote:
    "a 12-second widescreen premium film of the user's product as a timed list of four shots in one prompt, each shot at least 2 seconds, ending held on the hero frame; the product kept as in the photo; the user fills in the look (for example cool and minimal) and the one detail shown in slow motion",
  goal: "ecommerce",
  triggers: {
    asks: ["a premium product film", "a high-end product commercial"],
    offerWhen: ["the user's brand is premium"],
  },
};
