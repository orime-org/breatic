// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 20-second vertical ad showing the user's product in three colours or styles, one after another. */
export const VARIANT_CAROUSEL_AD: GenerationTemplate = {
  id: "variant-carousel-ad",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 20, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "variant-1", type: "image" },
    { key: "variant-2", type: "image" },
    { key: "variant-3", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 20-second vertical ad showing the same product in the three colours or styles of the user's three photos, one part each, in one camera position and light, joined by the same transition and ending with all three side by side for the last 2 seconds; each part keeps the colour of its own photo and the shape stays the same; the user fills in the backdrop colour and the transition",
  goal: "ecommerce",
  triggers: {
    asks: ["a video showing all the colours", "a multi-variant product video"],
    offerWhen: ["the user adds photos of the same product in several colours or styles"],
  },
};
