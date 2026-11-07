// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 0.5x fisheye phone shot from above, the place filled with clones of one subject. */
export const FISHEYE_CLONE_POV: GenerationTemplate = {
  id: "fisheye-clone-pov",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "4:5" } },
  ],
  edges: [],
  inputs: [
    { key: "subject", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 4:5 phone photo taken with the 0.5x ultra-wide lens from above, a place the user names filled with about 12 clones of the user's subject in different poses",
  goal: "social-hooks",
  triggers: {
    asks: ["clones of me", "a fisheye shot", "many copies of the same person"],
    offerWhen: [],
  },
};
