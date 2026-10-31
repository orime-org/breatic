// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A character designed from a description, then drawn into a full character sheet. */
export const CHARACTER_DESIGN_FROM_TEXT: GenerationTemplate = {
  id: "character-design-from-text",
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
    {
      key: "design",
      role: "generate",
      type: "image",
      mode: "t2i",
      model: "gpt-image-2.5-sunburst-text-to-image",
      params: { aspect_ratio: "3:4" },
    },
  ],
  edges: [{ from: "design", to: "result", into: "pool" }],
  inputs: [],
  steps: [],
  agentNote:
    "a new character designed from the reader's description and style as one full-body picture, then drawn into a full character sheet; for when there is no picture of the character yet",
  goal: "character",
  triggers: {
    asks: ["design a character for me", "create a new character", "I need a character but have no picture of it"],
    offerWhen: ["the reader wants work driven by a character and has no picture of that character"],
  },
};
