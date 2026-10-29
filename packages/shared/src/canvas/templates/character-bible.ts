// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** One full character sheet of a character from a reference: the main views, palette, silhouette, expressions, angles, poses and details. */
export const CHARACTER_BIBLE: GenerationTemplate = {
  id: "character-bible",
  anchor: "result",
  nodes: [
    {
      key: "result",
      role: "generate",
      type: "image",
      mode: "i2i",
      model: "nano-banana-pro-edit-ultra",
      params: { aspect_ratio: "4:3", resolution: "4k" },
    },
  ],
  edges: [],
  inputs: [{ key: "reference", type: "image" }],
  steps: [],
  agentNote:
    "one large character sheet of the reference character: four main views, a colour palette, a silhouette, expressions, head angles, poses, outfit details and hand gestures, all in one style; the base for keeping that character the same everywhere",
  goal: "character",
  triggers: {
    asks: ["a character card", "a character sheet or model sheet", "character design reference", "keep my character consistent"],
    offerWhen: [
      "the reader plans a comic series, a short drama or a music video, or wants one character in two or more pictures or videos, and the canvas has no character sheet for them yet",
    ],
  },
};
