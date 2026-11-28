// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 12-second vertical livestream selling clip: one host pitching the user's product to camera. */
export const LIVESTREAM_PITCH: GenerationTemplate = {
  id: "livestream-pitch",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "ref", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 12, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "host", type: "image" },
    { key: "product", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 12-second vertical livestream selling clip in three timed parts: the host from the user's photo pitches the product from the other photo in a lit live-shopping room, brings it up close to the lens and ends holding it next to their face; the host and the product each kept as in their photo; the user fills in the selling points and the tone",
  goal: "ecommerce",
  triggers: {
    asks: ["a livestream selling clip", "a live shopping video"],
    offerWhen: ["the user sells the product through livestreams"],
  },
};
