// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A sheet of one character's expressions, micro-expressions and head angles, from a reference. */
export const EXPRESSION_SHEET: GenerationTemplate = {
  id: "expression-sheet",
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
    "a sheet of the reference character's expressions, micro-expressions and head angles with the same face, hair and light, for dialogue scenes and emotional close-ups",
  goal: "character",
  triggers: {
    asks: ["an expression sheet", "my character's expressions", "facial expressions of my character"],
    offerWhen: [
      "the reader is making dialogue or emotional close-ups of a character and the canvas has no expressions of them, or only small ones on a character sheet",
    ],
  },
};
