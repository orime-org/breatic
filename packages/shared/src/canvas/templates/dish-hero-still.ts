// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The user's dish reshot as a studio menu photo, the same food, plating and tableware. */
export const DISH_HERO_STILL: GenerationTemplate = {
  id: "dish-hero-still",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "image", mode: "i2i", model: "gpt-image-2.5-sunburst-edit", params: { aspect_ratio: "4:5" } },
  ],
  edges: [],
  inputs: [
    { key: "dish", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 4:5 studio menu photo of the user's dish, the same food, plating and tableware as in their photo: warm key light from 45 degrees, back light on the steam, side light for texture, colours vivid but natural, on a surface and background the user names",
  goal: "food",
  triggers: {
    asks: ["a menu photo", "food photography", "a professional photo of my dish"],
    offerWhen: ["the user's photo of a dish is a casual snapshot"],
  },
};
