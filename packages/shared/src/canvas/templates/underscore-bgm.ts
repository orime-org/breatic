// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** Instrumental background music sitting under narration or picture, cut to the video's length. */
export const UNDERSCORE_BGM: GenerationTemplate = {
  id: "underscore-bgm",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "audio", mode: "t2m", model: "lyria-3-pro-music", params: {} },
  ],
  edges: [],
  inputs: [],
  steps: ["trim"],
  agentNote:
    "instrumental background music to sit under a voice-over or a picture: genre, tempo, key, two or three instruments and the energy over time, asked for at the video's length; the user trims it to the video's length afterwards",
  goal: "sound",
  triggers: {
    asks: ["background music", "BGM", "music under a video"],
    offerWhen: ["the user's video is done but has no music"],
  },
};
