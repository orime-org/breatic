// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The user's song redone in another style. */
export const SONG_COVER: GenerationTemplate = {
  id: "song-cover",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "audio", mode: "a2m", model: "minimax-music-cover", params: {} },
  ],
  edges: [],
  inputs: [
    { key: "song", type: "audio", into: "audio" },
  ],
  steps: [],
  agentNote:
    "the user's song redone in another style, keeping its melody and lyrics; the user picks their song into the audio slot",
  goal: "sound",
  triggers: {
    asks: ["a cover of a song", "the same song in another style"],
    offerWhen: [],
  },
};
