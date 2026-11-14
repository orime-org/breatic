// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** One extreme sports move from run-up to landing in a single take, gravity and contact obeyed. */
export const EXTREME_SPORTS_RUN: GenerationTemplate = {
  id: "extreme-sports-run",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 10, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "rider", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 10-second 9:16 single take of the user's person doing one extreme sports move the user names (skiing, snowboarding, skateboarding, parkour), from run-up through take-off and the move in the air to a landing with weight, the camera following on the move with no cuts",
  goal: "speed",
  triggers: {
    asks: ["a skiing or snowboarding video", "a skateboard trick clip", "a parkour video"],
    offerWhen: [],
  },
};
