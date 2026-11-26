// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The performer, in the video's look, lip-syncing the chorus of the user's song. */
export const MV_CHORUS_PERFORMANCE: GenerationTemplate = {
  id: "mv-chorus-performance",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "talking_head", model: "seedance-2.5-talking-avatar", params: {} },
    { key: "look", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9" } },
  ],
  edges: [{ from: "look", to: "result", into: "image" }],
  inputs: [
    { key: "performer", type: "image", feeds: ["look"] },
    { key: "chorus", type: "audio", into: "audio" },
  ],
  steps: [],
  agentNote:
    "the chorus of the user's song sung on camera by the user's performer: a widescreen still of the performer at the microphone in the video's look is generated first from their picture and goes into the character slot, and the chorus, cut from the song with Cut, goes into the driving audio slot, so the mouth follows the real vocal and the clip lasts as long as the chorus; the user fills in the look, the place and the manner",
  goal: "music-video",
  triggers: {
    asks: ["lip-sync my song", "the singer singing the chorus"],
    offerWhen: ["the user's music video has the singer on screen singing the chorus"],
  },
};
