// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** Music for the user's own video, following its mood, pace and cuts. */
export const SCORE_FOR_MY_VIDEO: GenerationTemplate = {
  id: "score-for-my-video",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "audio", mode: "a2m", model: "sonilo-video-to-music", params: {} },
  ],
  edges: [],
  inputs: [
    { key: "video", type: "video", into: "video" },
  ],
  steps: [],
  agentNote:
    "music made for the user's own video, following its mood, pace and scene changes; the user picks the video into the video slot",
  goal: "sound",
  triggers: {
    asks: ["music for this video", "score my video"],
    offerWhen: ["the user uploaded a video with no music"],
  },
};
