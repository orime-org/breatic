// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** Three continuous shots of one character from a single reference, the identity held in every shot. */
export const IDENTITY_LOCKED_SEQUENCE: GenerationTemplate = {
  id: "identity-locked-sequence",
  anchor: "result",
  nodes: [
    {
      key: "result",
      role: "generate",
      type: "video",
      mode: "ref",
      model: "minimax-h3-reference-to-video",
      params: { aspect_ratio: "16:9", duration: 8 },
    },
  ],
  edges: [],
  inputs: [{ key: "reference", type: "image" }],
  steps: [],
  agentNote:
    "an 8-second video of three continuous shots of the reference character, written with timecodes, the same identifying features repeated in each shot so the face and outfit do not drift",
  goal: "character",
  triggers: {
    asks: ["several shots of the same character", "a short sequence with my character"],
    offerWhen: ["the reader wants several shots in a row of one character and has only one picture of their face"],
  },
};
