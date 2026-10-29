// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** One 5x5 storyboard picture of a continuous story, from a character or scene reference. */
export const STORYBOARD_GRID_25: GenerationTemplate = {
  id: "storyboard-grid-25",
  anchor: "result",
  nodes: [
    {
      key: "result",
      role: "generate",
      type: "image",
      mode: "i2i",
      model: "nano-banana-pro-edit-ultra",
      params: { aspect_ratio: "1:1", resolution: "4k" },
    },
  ],
  edges: [],
  inputs: [{ key: "reference", type: "image" }],
  steps: [],
  agentNote:
    "one 5x5 storyboard picture of a continuous story, the same characters and place in every panel; made to be turned into a video afterwards",
};
