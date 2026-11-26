// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The user's lyrics, sung as a whole song in the style they describe. */
export const SONG_WITH_LYRICS: GenerationTemplate = {
  id: "song-with-lyrics",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "audio", mode: "t2m", model: "mureka-v9.5-generate-song", params: {} },
    { key: "lyrics", role: "written", type: "text" },
  ],
  edges: [{ from: "lyrics", to: "result", into: "lyrics" }],
  inputs: [],
  steps: [],
  agentNote:
    "a song with vocals sung from the user's lyrics: the lyrics are a text node marked into verses and a chorus, wired into the song's lyrics box; the prompt gives the genre, tempo in BPM, key, instruments, the voice and how the energy rises from verse to chorus; the user fills in the lyrics and the style",
  goal: "music-video",
  triggers: {
    asks: ["write a song", "turn these lyrics into a song"],
    offerWhen: ["the user gives lyrics or a poem and wants a version that can be sung"],
  },
};
