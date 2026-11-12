// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A hand-drawn screen-print travel poster of a place in its festival or season. */
export const DESTINATION_FESTIVAL_POSTER: GenerationTemplate = {
  id: "destination-festival-poster",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "image", mode: "t2i", model: "gpt-image-2.5-sunburst-text-to-image", params: { aspect_ratio: "3:4" } },
  ],
  edges: [],
  inputs: [],
  steps: [],
  agentNote:
    "a 3:4 hand-drawn screen-print travel poster of a place during a festival or season the user names, in 4 to 6 ink colours with slightly misregistered layers, with one hand-lettered title the user gives; the title must stay in the picture spelled exactly right, and no other text appears",
  goal: "posters",
  triggers: {
    asks: ["a festival poster", "a travel poster", "a holiday poster for a city"],
    offerWhen: ["the user mentions marketing for a festival or a holiday"],
  },
};
