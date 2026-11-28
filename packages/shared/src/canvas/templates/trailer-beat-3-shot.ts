// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 12-second trailer beat in three shots: the world, the hero in action, a close-up with one line. */
export const TRAILER_BEAT_3_SHOT: GenerationTemplate = {
  id: "trailer-beat-3-shot",
  anchor: "result",
  nodes: [
    {
      key: "result",
      role: "generate",
      type: "video",
      mode: "ref",
      model: "seedance-2.5-text-to-video",
      params: { aspect_ratio: "21:9", duration: 12, generate_audio: true },
      shots: [{ seconds: 4 }, { seconds: 4 }, { seconds: 4 }],
    },
  ],
  edges: [],
  inputs: [{ key: "hero", type: "image" }],
  steps: [],
  agentNote:
    "a 12-second scope-ratio trailer beat in three 4-second shots: an establishing shot of the world, the user's hero in one big action, and a close-up of the hero saying one line, under a rising trailer score; the user fills in the world, the action and the line",
  goal: "cinematic",
  triggers: {
    asks: ["a trailer", "a teaser for my story"],
    offerWhen: ["the user wants to promote a story or a character"],
  },
};
