// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** One line or a short narration, read exactly as written. */
export const VOICE_LINE: GenerationTemplate = {
  id: "voice-line",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "audio", mode: "tts", model: "minimax-speech-2.8-hd", params: {} },
  ],
  edges: [],
  inputs: [],
  steps: [],
  agentNote:
    "one line or a short narration read exactly as the user wrote it, with its pace, pauses and breaths written out, as a dry voice-over",
  goal: "sound",
  triggers: {
    asks: ["a voice-over", "narration", "a line read aloud"],
    offerWhen: ["the user has written a narration script"],
  },
};
