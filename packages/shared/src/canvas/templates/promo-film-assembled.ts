// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 60-second promo film: one score cut into four 15-second pieces, a part made to each, joined in order. */
export const PROMO_FILM_ASSEMBLED: GenerationTemplate = {
  id: "promo-film-assembled",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "16:9", duration: 15 } },
    { key: "part-2", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "16:9", duration: 15 } },
    { key: "part-3", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "16:9", duration: 15 } },
    { key: "part-4", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "16:9", duration: 15 } },
    { key: "score", role: "generate", type: "audio", mode: "t2m", model: "mureka-v9.5-generate-bgm", params: {} },
  ],
  edges: [],
  inputs: [{ key: "brand", type: "image", feeds: ["result", "part-2", "part-3", "part-4"] }],
  steps: ["trim", "join"],
  agentNote:
    "a 60-second widescreen promo film in four 15-second parts, the hook, the world, the change and the brand signature, made to one score: the score is generated first beside the parts and comes out a few minutes long, so the user cuts four back-to-back 15-second pieces of it with Cut, connects each to its part and @s it where that part's prompt asks, as the video model plays the clip it is given as the soundtrack, then joins the four parts in order; every part repeats the same shared description of the brand's look; the user fills in the brand, the look and what each part shows",
  goal: "promo",
  triggers: {
    asks: ["a promo film", "a one-minute brand video"],
    offerWhen: ["the user wants a promo longer than 30 seconds"],
  },
};
