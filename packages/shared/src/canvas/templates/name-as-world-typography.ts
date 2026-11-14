// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A name built as a miniature world, its letters reshaped by what it is known for. */
export const NAME_AS_WORLD_TYPOGRAPHY: GenerationTemplate = {
  id: "name-as-world-typography",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "image", mode: "t2i", model: "gpt-image-2.5-sunburst-text-to-image", params: { aspect_ratio: "3:4" } },
  ],
  edges: [],
  inputs: [],
  steps: [],
  agentNote:
    "a 3:4 typographic illustration of a name the user gives (a city, a company or an event), each letter or character built as a tiny model and reshaped by what the name is known for, with 6 to 14 short hand-written annotations and one accent colour; the name and the annotations must stay in the picture, the name spelled and shaped exactly right, and no other text appears",
  goal: "posters",
  triggers: {
    asks: ["a typography poster", "lettering design", "a name made into a picture"],
    offerWhen: ["the user wants a key visual for a city, a company or an event"],
  },
};
