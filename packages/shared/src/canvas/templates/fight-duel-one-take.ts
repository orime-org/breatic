// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** Two fighters in one 15-second take, every move readable, the camera moving with the fight. */
export const FIGHT_DUEL_ONE_TAKE: GenerationTemplate = {
  id: "fight-duel-one-take",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "16:9", duration: 15, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "fighter-a", type: "image" },
    { key: "fighter-b", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 15-second widescreen duel with sound between the user's two fighters in one continuous take, written beat by beat in seconds: the camera pushes in on an attack, pulls back on a block and circles while they are locked, each landed hit freezing for a split second with a shake, ending on a slow pull-out at medium close-up, no blood; the user fills in the place, the moves and the deciding blow",
  goal: "fight",
  triggers: {
    asks: ["a fight scene", "a duel between two characters", "a martial arts fight"],
    offerWhen: ["two characters in the user's story come to blows"],
  },
};
