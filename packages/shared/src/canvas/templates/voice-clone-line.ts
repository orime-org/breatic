// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A new line read in the voice of the user's recording. */
export const VOICE_CLONE_LINE: GenerationTemplate = {
  id: "voice-clone-line",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "audio", mode: "voice_clone", model: "minimax-voice-clone", params: {} },
  ],
  edges: [],
  inputs: [
    { key: "sample", type: "audio", into: "audio" },
  ],
  steps: [],
  agentNote:
    "a new line read in the voice of a recording the user gives; the user picks the recording into the audio slot",
  goal: "sound",
  triggers: {
    asks: ["read this in my voice", "a line in my own voice"],
    offerWhen: ["the user has uploaded a recording of their own voice and needs a voice-over"],
  },
};
