// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 20-second brand story in five shots: the maker's hands, their world, the spark, the making, the product in a customer's life. */
export const BRAND_ORIGIN_FILM: GenerationTemplate = {
  id: "brand-origin-film",
  anchor: "result",
  nodes: [
    {
      key: "result",
      role: "generate",
      type: "video",
      mode: "multi_shot",
      model: "seedance-2.5-text-to-video",
      params: { aspect_ratio: "16:9", duration: 20, generate_audio: true },
      shots: [{ seconds: 4 }, { seconds: 4 }, { seconds: 4 }, { seconds: 4 }, { seconds: 4 }],
    },
  ],
  edges: [],
  inputs: [
    { key: "maker", type: "image" },
    { key: "product", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 20-second widescreen brand story with sound in five 4-second shots: the maker's hands at work, the world they work in, the moment of inspiration, a montage of the making, and the product in a customer's life; feeling first and facts after, shown and not told, the customer as the hero, ending on a feeling rather than a logo, with one short line of voice-over at most; the user fills in the craft, the place, the spark and the customer's moment",
  goal: "promo",
  triggers: {
    asks: ["a brand story", "a brand film", "the story of how we started"],
    offerWhen: ["the user is telling the story of their business or their craft"],
  },
};
