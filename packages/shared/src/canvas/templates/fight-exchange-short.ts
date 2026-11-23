// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** One 8-second exchange: a dash, a clash, a hit, a knock-back and a recovered stance. */
export const FIGHT_EXCHANGE_SHORT: GenerationTemplate = {
  id: "fight-exchange-short",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "16:9", duration: 8 } },
  ],
  edges: [],
  inputs: [
    { key: "fighter-a", type: "image" },
    { key: "fighter-b", type: "image" },
  ],
  steps: [],
  agentNote:
    "an 8-second widescreen single exchange between the user's two fighters: a dash in, a clash, one hit, a knock-back and both back in stance, each beat with its own camera move written as a camera command; cheaper and shorter than a full duel; the user fills in the place and the hit",
  goal: "fight",
  triggers: {
    asks: ["one fight shot", "a quick exchange of blows"],
    offerWhen: ["the user wants a fight but on a small budget, or only one clash"],
  },
};
