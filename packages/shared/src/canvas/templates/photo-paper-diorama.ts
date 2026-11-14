// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The user's photo kept above and torn into paper craft below, with two hand-written lines. */
export const PHOTO_PAPER_DIORAMA: GenerationTemplate = {
  id: "photo-paper-diorama",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "image", mode: "i2i", model: "gpt-image-2.5-sunburst-edit", params: { aspect_ratio: "3:4" } },
  ],
  edges: [],
  inputs: [
    { key: "photo", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 3:4 collage of the user's photo: its top half kept as it is, its bottom half torn handmade paper with one element the user names raised as a paper-craft relief, and two short hand-written lines the user gives; the two lines must stay in the picture spelled exactly right, and no other text appears",
  goal: "posters",
  triggers: {
    asks: ["paper craft", "a collage of my photo", "a paper diorama"],
    offerWhen: [],
  },
};
