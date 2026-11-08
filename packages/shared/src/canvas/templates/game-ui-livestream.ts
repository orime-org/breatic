// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** Gameplay that looks like a livestreamed video game, the user's character as the player. */
export const GAME_UI_LIVESTREAM: GenerationTemplate = {
  id: "game-ui-livestream",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 12, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "character", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 12-second vertical clip that looks like a livestreamed video game with the user's character as the player: the interface drawn as shapes and colours with no readable letters or numbers",
  goal: "social-hooks",
  triggers: {
    asks: ["a game livestream look", "make it look like a video game", "gameplay footage"],
    offerWhen: [],
  },
};
