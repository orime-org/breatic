// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 12-second vertical livestream selling clip: one host pitching the user's product to camera. */
export const LIVESTREAM_PITCH: GenerationTemplate = {
  id: "livestream-pitch",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 12, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "host", type: "image" },
    { key: "product", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 12-second vertical livestream selling clip: the host from the user's photo pitches the product from the other photo in a lit live-shopping room, holding it up close to the lens; the host and the product each kept as in their photo; the user fills in the selling points and the tone",
  goal: "ecommerce",
  triggers: {
    asks: ["a livestream selling clip", "a live shopping video"],
    offerWhen: ["the user sells the product through livestreams"],
  },
};
