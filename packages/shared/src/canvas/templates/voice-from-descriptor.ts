// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A voice described in words saying the user's line. */
export const VOICE_FROM_DESCRIPTOR: GenerationTemplate = {
  id: "voice-from-descriptor",
  anchor: "result",
  nodes: [
    {
      key: "result",
      role: "generate",
      type: "audio",
      mode: "tts",
      model: "qwen3-tts-voice-design",
      params: { voice_description: "A calm, warm adult voice, mid-range pitch, unhurried, speaking close to the microphone" },
    },
  ],
  edges: [],
  inputs: [],
  steps: [],
  agentNote:
    "the user's line spoken in a voice described in words (age, gender, texture, attitude, pace) in the Voice description param, written in English",
  goal: "sound",
  triggers: {
    asks: ["a voice that sounds like a certain kind of person", "a described voice"],
    offerWhen: ["the user describes how a character sounds"],
  },
};
