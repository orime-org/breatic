// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A section of the user's own song played by their performer, the cuts on its beats. */
export const BEAT_SYNCED_MUSIC_CLIP: GenerationTemplate = {
  id: "beat-synced-music-clip",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "16:9", duration: 15 } },
  ],
  edges: [],
  inputs: [
    { key: "song", type: "audio" },
    { key: "performer", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 15-second widescreen music-video clip of the user's performer cut to a 15-second piece of the user's own song: the piece goes into the pool and is the soundtrack and the clock, as this model plays the clip it is given as the video's sound; energy follows the song's sections, the cuts land on strong beats but not every beat, the biggest change is kept for the drop and the picture stops hard on the last note; a longer song is cut to 15 seconds with Cut first, and a shorter piece takes the duration set to its length; the user fills in the scene and what the performer does",
  goal: "music-video",
  triggers: {
    asks: ["a video cut to the beat of my song", "a music video for my song"],
    offerWhen: ["the user adds a piece of music and talks about a video"],
  },
};
