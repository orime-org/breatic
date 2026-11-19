// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 25-second vertical unboxing of the user's product, from the closed package to the product in hand. */
export const UNBOXING_AD: GenerationTemplate = {
  id: "unboxing-ad",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 25, generate_audio: true } },
  ],
  edges: [],
  inputs: [{ key: "product", type: "image" }],
  steps: [],
  agentNote:
    "a 25-second vertical unboxing in five timed parts (the package, opening it, taking the product out, its details, using it), starting on the package; the product kept as in the photo; the user fills in what the package looks like and the two details shown in close-up",
  goal: "ecommerce",
  triggers: {
    asks: ["an unboxing video"],
    offerWhen: ["the user's product packaging is a selling point"],
  },
};
