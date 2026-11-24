// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A hand-painted anime background, then a slow drifting shot of it. */
export const ANIME_SCENE: GenerationTemplate = {
  id: "anime-scene",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "i2v", model: "seedance-2.5-image-to-video", params: { duration: 6, generate_audio: true } },
    { key: "scene", role: "generate", type: "image", mode: "t2i", model: "gpt-image-2.5-sunburst-text-to-image", params: { aspect_ratio: "16:9" } },
  ],
  edges: [{ from: "scene", to: "result", into: "image" }],
  inputs: [],
  steps: [],
  agentNote:
    "a 6-second widescreen anime scene: a hand-painted anime background is generated first and picked into the video's first frame, then one slow camera move with only ambient motion (clouds, leaves, light) and the painted look held; the user fills in the place and time, the camera move and what moves",
  goal: "animation",
  triggers: {
    asks: ["an anime landscape", "an anime-style scene"],
    offerWhen: ["the user wants an anime-style mood shot or an opening backdrop"],
  },
};
