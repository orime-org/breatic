// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** Two people from the user's photos in one shot, each speaking their own voice-over in turn. */
export const TWO_SPEAKER_TALK: GenerationTemplate = {
  id: "two-speaker-talk",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "talking_head", model: "infinitetalk-multi", params: { order: "left_right" } },
    { key: "scene", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9" } },
    { key: "left-voice", role: "generate", type: "audio", mode: "tts", model: "minimax-speech-2.8-hd", params: { emotion: "neutral" } },
    { key: "right-voice", role: "generate", type: "audio", mode: "tts", model: "minimax-speech-2.8-hd", params: { emotion: "neutral" } },
  ],
  edges: [
    { from: "scene", to: "result", into: "image" },
    { from: "left-voice", to: "result", into: "left_audio" },
    { from: "right-voice", to: "result", into: "right_audio" },
  ],
  inputs: [
    { key: "left-person", type: "image", feeds: ["scene"] },
    { key: "right-person", type: "image", feeds: ["scene"] },
  ],
  steps: [],
  agentNote:
    "a widescreen two-person conversation, a podcast or an interview: one picture of the two people from the user's photos side by side is generated, each person's lines are voiced separately, and the left speaker talks first, then the right; the user fills in the setting and each person's lines and picks a voice for each that fits them",
  goal: "talking",
  triggers: {
    asks: ["a conversation between two people", "a podcast video"],
    offerWhen: ["the user's script has two speakers"],
  },
};
