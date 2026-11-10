// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** Early-2000s camcorder found footage of one small event, ending on a hard cut to black. */
export const RETRO_FOUND_FOOTAGE: GenerationTemplate = {
  id: "retro-found-footage",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "4:3", duration: 10, generate_audio: true } },
  ],
  edges: [],
  inputs: [],
  steps: [],
  agentNote:
    "a 10-second 4:3 found-footage clip with the look of an early-2000s home camcorder: one small event at a place the user names, a hard cut to black at the end; needs the place and the event",
  goal: "social-hooks",
  triggers: {
    asks: ["retro camcorder footage", "an old home video look", "found footage"],
    offerWhen: [],
  },
};
