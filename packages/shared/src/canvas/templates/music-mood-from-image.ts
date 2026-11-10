// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** Music in the mood of a picture. */
export const MUSIC_MOOD_FROM_IMAGE: GenerationTemplate = {
  id: "music-mood-from-image",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "audio", mode: "t2m", model: "lyria-3-pro-music", params: {} },
  ],
  edges: [],
  inputs: [
    { key: "image", type: "image", into: "image" },
  ],
  steps: [],
  agentNote:
    "music whose genre, key and instruments follow the mood of a picture the user gives; the user picks the picture into the image slot",
  goal: "sound",
  triggers: {
    asks: ["music that matches this picture", "music with the feel of this image"],
    offerWhen: ["the user has a poster or a cover and needs sound for it"],
  },
};
