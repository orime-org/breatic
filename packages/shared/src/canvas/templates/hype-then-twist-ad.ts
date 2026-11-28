// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 12-second vertical ad that builds the user's product up like a luxury commercial, then reveals how plain it is. */
export const HYPE_THEN_TWIST_AD: GenerationTemplate = {
  id: "hype-then-twist-ad",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "ref", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 12, generate_audio: true } },
  ],
  edges: [],
  inputs: [{ key: "product", type: "image" }],
  steps: [],
  agentNote:
    "a 12-second vertical funny ad in six 2-second parts: four shots like a luxury commercial build the user's product up, then the reveal shows it plainly and the music cuts out at that moment; it ends on the product held still in everyday light, a beat of silence, then one ordinary sound; the product kept as in the photo; the user fills in what the reveal shows and that one ordinary sound",
  goal: "ecommerce",
  triggers: {
    asks: ["a twist ad", "a funny product ad"],
    offerWhen: ["the user's product is plain and they want the ad to be shared"],
  },
};
