// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A spin on each beat swaps the person's outfit and backdrop to the next theme. */
export const BEAT_SYNC_OUTFIT_CHANGE: GenerationTemplate = {
  id: "beat-sync-outfit-change",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 12, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "person", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 12-second vertical outfit-change challenge of the reader's person: on each beat they spin and come back in the next theme's outfit and backdrop, the face and build unchanged; the reader lists the themes",
  goal: "social-hooks",
  triggers: {
    asks: ["an outfit change on the beat", "a transformation video", "a transition challenge"],
    offerWhen: ["the reader wants a dress-up or transformation challenge video"],
  },
};
