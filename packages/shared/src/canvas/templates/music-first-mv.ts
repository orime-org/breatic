// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** Music made first, then a music-video clip of the user's performer cut to it. */
export const MUSIC_FIRST_MV: GenerationTemplate = {
  id: "music-first-mv",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "16:9", duration: 15 } },
    { key: "music", role: "generate", type: "audio", mode: "t2m", model: "mureka-v9.5-generate-bgm", params: {} },
  ],
  edges: [],
  inputs: [{ key: "performer", type: "image" }],
  steps: ["trim"],
  agentNote:
    "a 15-second widescreen music-video clip of the user's performer made to music generated first: the music is generated beside the video with its tempo in BPM written out, and as it comes out a few minutes long the user cuts 15 seconds of it with Cut, connects the cut clip to the video and @s it where the prompt asks, as this model plays the clip it is given as the video's sound; the cuts land on its strong beats; the user fills in the genre and tempo, the scene and what the performer does",
  goal: "music-video",
  triggers: {
    asks: ["make the music first, then the video", "a music video with new music"],
    offerWhen: ["the user wants a rhythmic video and has no music for it"],
  },
};
