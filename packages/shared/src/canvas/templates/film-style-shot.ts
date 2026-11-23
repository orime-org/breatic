// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A styled still of the user's subject first, then a 5-second shot that moves in that style's own camera (inner#1817). */
export const FILM_STYLE_SHOT: GenerationTemplate = {
  id: "film-style-shot",
  anchor: "result",
  styles: "film-styles",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "i2v", model: "seedance-2.5-image-to-video", params: { duration: 5, generate_audio: true }, styleWords: "shot" },
    { key: "still", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9" }, styleWords: "still" },
  ],
  edges: [{ from: "still", to: "result", into: "image" }],
  inputs: [{ key: "subject", type: "image", feeds: ["still"] }],
  steps: [],
  agentNote:
    "a 5-second widescreen shot with sound in one classic style picked from the film styles: the user's subject is redrawn as a styled still first, which becomes the first frame, then it moves with that style's own camera and a transition made by the medium itself; the style's look holds in every frame; read the template with a style to get that style's words",
  goal: "film-styles",
  triggers: {
    asks: ["make the art style move", "animate my picture in a painting or print style"],
    offerWhen: ["the user has just made a styled still and wants it to move"],
  },
};
