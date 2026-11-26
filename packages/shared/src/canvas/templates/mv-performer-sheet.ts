// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The singer drawn in the music video's look, the identity reference every section takes. */
export const MV_PERFORMER_SHEET: GenerationTemplate = {
  id: "mv-performer-sheet",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9" } },
    { key: "style", role: "generate", type: "image", mode: "t2i", model: "gpt-image-2.5-sunburst-text-to-image", params: { aspect_ratio: "16:9" } },
  ],
  edges: [{ from: "style", to: "result", into: "pool" }],
  inputs: [{ key: "performer", type: "image" }],
  steps: [],
  agentNote:
    "a 16:9 sheet of the user's singer or character in the music video's look, full body from the front, side and back and a face close-up, wearing the video's wardrobe: a style board is generated first and goes into the pool for its look only; the face, hair and build stay the user's; to wire into every section of the video; the user fills in the song's mood, the visual direction and the outfit",
  goal: "music-video",
  triggers: {
    asks: ["me in my music video", "the singer for my music video"],
    offerWhen: ["the user's music video has a performer on screen"],
  },
};
