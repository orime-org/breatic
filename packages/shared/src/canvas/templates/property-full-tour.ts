// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 40-second room-by-room property tour: one 10-second part per room, made to one score, joined in order. */
export const PROPERTY_FULL_TOUR: GenerationTemplate = {
  id: "property-full-tour",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "16:9", duration: 10 } },
    { key: "room-2", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "16:9", duration: 10 } },
    { key: "room-3", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "16:9", duration: 10 } },
    { key: "room-4", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "16:9", duration: 10 } },
    { key: "score", role: "generate", type: "audio", mode: "t2m", model: "mureka-v9.5-generate-bgm", params: {} },
  ],
  edges: [],
  inputs: [
    { key: "photo-1", type: "image", feeds: ["result"] },
    { key: "photo-2", type: "image", feeds: ["room-2"] },
    { key: "photo-3", type: "image", feeds: ["room-3"] },
    { key: "photo-4", type: "image", feeds: ["room-4"] },
  ],
  steps: ["trim", "more", "join"],
  agentNote:
    "a 40-second widescreen room-by-room property tour, one 10-second part per room from its photo, made to one score chosen for the property type: the score is generated first beside the parts and comes out a few minutes long, so the user cuts back-to-back 10-second pieces of it with Cut, connects each to its part and @s it where that part's prompt asks, as the video model plays the clip it is given as the soundtrack, then joins the parts in order; every part repeats the same description of the home and the light; for more than four rooms, add a part per room as an ordinary node on the same model with its photo, and cut one more piece; the user fills in the home, the light and each room's camera move",
  goal: "spaces",
  triggers: {
    asks: ["a full property tour", "a house tour video room by room"],
    offerWhen: ["the user has more than four rooms or wants a tour longer than 30 seconds"],
  },
};
