// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The camera circles a character standing still, from the front round to the back, to show the look. */
export const CHARACTER_SHOWCASE_ORBIT: GenerationTemplate = {
  id: "character-showcase-orbit",
  anchor: "result",
  nodes: [
    {
      key: "result",
      role: "generate",
      type: "video",
      mode: "ref",
      model: "minimax-h3-reference-to-video",
      params: { aspect_ratio: "16:9", duration: 6 },
    },
  ],
  edges: [],
  inputs: [{ key: "reference", type: "image" }],
  steps: [],
  agentNote:
    "a 6-second video in which the camera circles the reference character from the front round to the back while they stand still, at one height and distance, to show the whole look",
  goal: "character",
  triggers: {
    asks: ["show off my character's look", "spin around the character", "a turnaround video"],
    offerWhen: ["the reader has just made a character sheet or a costume sheet and wants to see the character in motion"],
  },
};
