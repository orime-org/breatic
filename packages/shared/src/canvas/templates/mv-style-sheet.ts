// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** One board of the music video's look, the reference every section of it takes. */
export const MV_STYLE_SHEET: GenerationTemplate = {
  id: "mv-style-sheet",
  anchor: "result",
  nodes: [{ key: "result", role: "generate", type: "image", mode: "t2i", model: "gpt-image-2.5-sunburst-text-to-image", params: { aspect_ratio: "16:9" } }],
  edges: [],
  inputs: [],
  steps: [],
  agentNote:
    "a 16:9 style board for a music video: a palette strip, the light, materials and textures, the wardrobe and the locations in one look, no lettering, to wire into the pool of every section of the video so they all share it; the user fills in the song's mood and the visual direction",
  goal: "music-video",
  triggers: {
    asks: ["a music video look", "a visual direction for my music video"],
    offerWhen: ["the user is about to make several sections of a music video and has not settled its look"],
  },
};
