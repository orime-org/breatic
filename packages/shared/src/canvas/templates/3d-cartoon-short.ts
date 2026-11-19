// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A character designed first, then a 3D animated short where it chases one goal. */
export const THREE_D_CARTOON_SHORT: GenerationTemplate = {
  id: "3d-cartoon-short",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "16:9", duration: 10, generate_audio: true } },
    { key: "design", role: "generate", type: "image", mode: "t2i", model: "gpt-image-2.5-sunburst-text-to-image", params: { aspect_ratio: "1:1" } },
  ],
  edges: [{ from: "design", to: "result", into: "pool" }],
  inputs: [],
  steps: [],
  agentNote:
    "a 10-second widescreen 3D animated short: an endearing character is designed first as one full-body picture, then the short follows it after one goal (it tries, hits a setback, gets there) with its signature item named the same way in the design and the video; for when the user wants an animated short and has no character yet; the user fills in the character, its signature item, the setting and the goal",
  goal: "animation",
  triggers: {
    asks: ["a 3D animated short", "an animated film-style clip"],
    offerWhen: ["the user wants an animated short but has no character yet"],
  },
};
