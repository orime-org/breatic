// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A phone selfie vlog the reader's pet takes over, ending with its nose on the lens. */
export const PET_SELFIE_VLOG: GenerationTemplate = {
  id: "pet-selfie-vlog",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 10, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "pet", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 10-second vertical phone selfie vlog in which the reader's pet walks in, steals the shot and ends with its nose filling the lens; exactly one animal, its real way of moving",
  goal: "social-hooks",
  triggers: {
    asks: ["a pet video", "a video of my dog or cat", "a funny vlog with my pet"],
    offerWhen: ["the reader adds a photo of their pet"],
  },
};
