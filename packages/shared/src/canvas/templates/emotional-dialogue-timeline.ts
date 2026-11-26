// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A spoken line generated first, then played as a close-up performance that keeps it as its sound. */
export const EMOTIONAL_DIALOGUE_TIMELINE: GenerationTemplate = {
  id: "emotional-dialogue-timeline",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "9:16", duration: 10 } },
    { key: "line", role: "generate", type: "audio", mode: "tts", model: "minimax-speech-2.8-hd", params: {} },
  ],
  edges: [{ from: "line", to: "result", into: "pool" }],
  inputs: [{ key: "character", type: "image" }],
  steps: [],
  agentNote:
    "a 10-second vertical close-up of the user's character saying one line with feeling: the line, short enough to say in about eight seconds, is generated as speech first and goes into the pool, where the video keeps that recording as its own sound and moves the lips to it; the performance is a chain of reactions (the news lands, a pause to understand, a reaction they cannot stop, the reaction they choose, an aftertaste), tears coming late and unevenly, the camera locked at medium close-up; the user fills in the line, the situation, both reactions and the place and light",
  goal: "drama",
  triggers: {
    asks: ["a crying scene", "a confession scene", "an emotional close-up with a spoken line"],
    offerWhen: ["the user wants a close-up performance of one character saying a line"],
  },
};
