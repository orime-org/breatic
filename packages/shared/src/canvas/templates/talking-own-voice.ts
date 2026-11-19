// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The user's own photo and recording, straight into a lip-synced talking clip. */
export const TALKING_OWN_VOICE: GenerationTemplate = {
  id: "talking-own-voice",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "talking_head", model: "seedance-2.5-talking-avatar", params: {} },
  ],
  edges: [],
  inputs: [
    { key: "portrait", type: "image", into: "image" },
    { key: "recording", type: "audio", into: "audio" },
  ],
  steps: [],
  agentNote:
    "a talking clip of the user's own photo speaking the user's own recording: the photo goes into the character slot and the recording into the driving audio slot, and the clip lasts as long as the recording; the user fills in the manner",
  goal: "talking",
  triggers: {
    asks: ["a talking video in my own voice", "make my photo say my recording"],
    offerWhen: ["the user adds a voice recording of their own"],
  },
};
