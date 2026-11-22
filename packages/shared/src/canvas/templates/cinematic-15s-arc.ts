// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 15-second cinematic scene with a 2-second hook and a whole arc: setting, character, rise, climax, release. */
export const CINEMATIC_15S_ARC: GenerationTemplate = {
  id: "cinematic-15s-arc",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "16:9", duration: 15, generate_audio: true } },
  ],
  edges: [],
  inputs: [{ key: "character", type: "image" }],
  steps: [],
  agentNote:
    "a 15-second widescreen cinematic scene with sound for the user's character: a 2-second hook already in motion, then the place, the character, a rise, a climax and a release, each beat in whole seconds, graded with one named look; the user fills in the place, what the character wants, the climax and the look",
  goal: "cinematic",
  triggers: {
    asks: ["make it look like a film", "a cinematic clip"],
    offerWhen: ["the user has a character and wants one scene with a rise and a climax"],
  },
};
