// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The user's building from day to lit-up night as first and end frame, one continuous change. */
export const DAY_TO_NIGHT_EXTERIOR: GenerationTemplate = {
  id: "day-to-night-exterior",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "first_last", model: "seedance-2.5-image-to-video", params: { duration: 6, generate_audio: true } },
    { key: "day", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9" } },
    { key: "night", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9" } },
  ],
  edges: [
    { from: "day", to: "night", into: "pool" },
    { from: "day", to: "result", into: "image" },
    { from: "night", to: "result", into: "end_image" },
  ],
  inputs: [{ key: "exterior", type: "image", feeds: ["day"] }],
  steps: [],
  agentNote:
    "a 6-second widescreen day-to-night of the user's building: a daylight picture is made from their exterior photo at the video's frame, a night picture with the windows and outdoor lights on is edited from it with the same camera, and the two become the first and end frame of one continuous change from day through dusk to night; the user fills in the light at night",
  goal: "spaces",
  triggers: {
    asks: ["a day to night video of my house", "show the building lit up at night"],
    offerWhen: ["the user is making an exterior video for a property listing"],
  },
};
