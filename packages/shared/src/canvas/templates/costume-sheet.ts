// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A character costume sheet: front, side and back views plus close-ups, from a character reference. */
export const COSTUME_SHEET: GenerationTemplate = {
  id: "costume-sheet",
  anchor: "result",
  nodes: [
    {
      key: "result",
      role: "generate",
      type: "image",
      mode: "i2i",
      model: "nano-banana-pro-edit-ultra",
      params: { aspect_ratio: "16:9", resolution: "4k" },
    },
  ],
  edges: [],
  inputs: [{ key: "reference", type: "image" }],
  steps: [],
  agentNote:
    "a character costume sheet: front, side and back full-body views plus close-ups of the hands or another body part, for keeping a character consistent",
  goal: "character",
  triggers: {
    asks: [
      "three views of my character",
      "a turnaround or costume sheet",
      "front, side and back views",
      "a fitting or wardrobe test shot",
    ],
    offerWhen: [
      "the reader is about to use one character in several pictures or videos and the canvas has no front, side and back views of them yet",
    ],
  },
};
