// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The user's own photo and recording, straight into a lip-synced talking clip. */
export const TALKING_OWN_VOICE: GenerationTemplate = {
  id: "talking-own-voice",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "talking_head", model: "omnihuman-1.5", params: {} },
  ],
  edges: [],
  inputs: [
    { key: "portrait", type: "image", into: "image" },
    { key: "recording", type: "audio", into: "audio" },
  ],
  steps: [],
  agentNote:
    "a talking clip of the user's own photo speaking the user's own recording: the photo goes into the character slot and the recording into the driving audio slot, and the clip lasts as long as the recording and plays the recording itself as its sound, however short; the model takes no prompt, so nothing is filled in",
  goal: "talking",
  triggers: {
    asks: ["a talking video in my own voice", "make my photo say my recording"],
    offerWhen: ["the user adds a voice recording of their own"],
  },
};
