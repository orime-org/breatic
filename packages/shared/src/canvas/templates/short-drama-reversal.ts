// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A vertical short-drama hook: the premise at once, rising tension, one reversal. */
export const SHORT_DRAMA_REVERSAL: GenerationTemplate = {
  id: "short-drama-reversal",
  anchor: "result",
  nodes: [{ key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 15, generate_audio: true } }],
  edges: [],
  inputs: [
    { key: "character-a", type: "image" },
    { key: "character-b", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 15-second vertical short-drama hook with sound between the user's two characters in one shot, in five timed beats: the premise is clear by the second beat, the tension climbs in at most three steps and shows on both faces before the turn, one reversal, then the camera holds on the losing side's reaction and the clip ends one beat later; the user fills in the place, the setup, the escalation, the sign before the turn, the reversal and the reaction",
  goal: "drama",
  triggers: {
    asks: ["a short drama with a twist", "a viral short-drama opening", "a reversal or face-slap scene"],
    offerWhen: ["the user wants a hook or an opening for a short drama"],
  },
};
