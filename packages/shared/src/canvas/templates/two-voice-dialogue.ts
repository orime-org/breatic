// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** Two named people talking, rendered in one pass. */
export const TWO_VOICE_DIALOGUE: GenerationTemplate = {
  id: "two-voice-dialogue",
  anchor: "result",
  nodes: [
    {
      key: "result",
      role: "generate",
      type: "audio",
      mode: "tts",
      model: "gemini-3.1-flash-text-to-speech",
      params: { speakers: [{ speaker: "Ava", voice: "Kore" }, { speaker: "Leo", voice: "Puck" }] },
    },
  ],
  edges: [],
  inputs: [],
  steps: [],
  agentNote:
    "a dialogue between two named speakers, Ava and Leo, rendered in one pass with a voice each; the script is one line per turn, each starting with the speaker's name and a colon",
  goal: "sound",
  triggers: {
    asks: ["a dialogue between two people as audio", "two voices talking"],
    offerWhen: ["the user's script has two speakers"],
  },
};
