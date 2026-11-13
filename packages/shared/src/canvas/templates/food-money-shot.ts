// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The user's dish built up in close-up to its most tempting moment, with close food sounds. */
export const FOOD_MONEY_SHOT: GenerationTemplate = {
  id: "food-money-shot",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 8, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "dish", type: "image" },
  ],
  steps: [],
  agentNote:
    "an 8-second vertical close-up video of the user's dish or drink: a slow-motion macro hook, a push in on its texture, then the most tempting moment the user names (a cheese pull, a pour) held at its peak, steam and gloss lit from behind, close food sounds in place of taste and no music",
  goal: "food",
  triggers: {
    asks: ["a food video", "a cheese pull shot", "sauce being poured over a dish"],
    offerWhen: ["the user adds a photo of a dish or a drink"],
  },
};
