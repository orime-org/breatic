// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** Two characters play one scene with lines in a set generated first. */
export const DRAMA_SINGLE_SCENE: GenerationTemplate = {
  id: "drama-single-scene",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "16:9", duration: 15, generate_audio: true } },
    { key: "scene", role: "generate", type: "image", mode: "t2i", model: "gpt-image-2.5-sunburst-text-to-image", params: { aspect_ratio: "16:9" } },
  ],
  edges: [{ from: "scene", to: "result", into: "pool" }],
  inputs: [
    { key: "character-a", type: "image" },
    { key: "character-b", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 15-second widescreen drama scene with sound between the user's two characters in one continuous shot: a picture of the empty set is generated first and goes into the pool for its room and light only, never as the first frame; the first frame already holds both in place, the scene runs in three timed beats, each reaction following from what the other just did, the lines declared in one language and kept to eight words or fewer each; the user fills in the situation, the beats, the lines and the light",
  goal: "drama",
  triggers: {
    asks: ["a drama scene", "a short drama clip", "two characters acting out a scene"],
    offerWhen: ["the user has pictures of two characters and describes a conflict or a conversation between them"],
  },
};
