// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** One comic page with the user's character, the speech balloons left empty for lettering added later. */
export const COMIC_PAGE: GenerationTemplate = {
  id: "comic-page",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "2:3", resolution: "4k" } },
  ],
  edges: [],
  inputs: [{ key: "character", type: "image" }],
  steps: [],
  agentNote:
    "one portrait comic page of five or six panels starring the user's character, the reading order written out, panel sizes following the pace, one line weight and screentone throughout, and empty speech balloons whose tails point at the speaker for lettering added later; the user fills in the reading order, the style and what happens in each panel",
  goal: "comics-storyboards",
  triggers: {
    asks: ["a comic page", "draw a comic"],
    offerWhen: ["the user has written a short story and wants it as pictures and text"],
  },
};
