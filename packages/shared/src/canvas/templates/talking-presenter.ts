// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A presenter portrait made from the user's photo and a voice-over, then a lip-synced talking clip of the two. */
export const TALKING_PRESENTER: GenerationTemplate = {
  id: "talking-presenter",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "talking_head", model: "seedance-2.5-talking-avatar", params: {} },
    { key: "portrait", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "9:16" } },
    { key: "voice", role: "generate", type: "audio", mode: "tts", model: "minimax-speech-2.8-hd", params: { emotion: "neutral" } },
  ],
  edges: [
    { from: "portrait", to: "result", into: "image" },
    { from: "voice", to: "result", into: "audio" },
  ],
  inputs: [{ key: "person", type: "image", feeds: ["portrait"] }],
  steps: [],
  agentNote:
    "a vertical talking-presenter clip of the person in the user's photo reading the user's script: a medium close-up presenter portrait is generated from the photo and a voice-over is generated from the script, both are picked into the talking video's character and driving audio slots, and the clip lasts as long as the voice-over; the user fills in the script, the setting and the manner",
  goal: "talking",
  triggers: {
    asks: ["a talking-head video", "a digital presenter reading my script"],
    offerWhen: ["the user has written a script they want someone to say on camera"],
  },
};
