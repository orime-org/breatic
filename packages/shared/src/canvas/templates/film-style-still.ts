// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The user's subject redrawn as one widescreen scene in a classic style the user picks (inner#1817). */
export const FILM_STYLE_STILL: GenerationTemplate = {
  id: "film-style-still",
  anchor: "result",
  styles: "film-styles",
  nodes: [
    { key: "result", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9" }, styleWords: "still" },
  ],
  edges: [],
  inputs: [{ key: "subject", type: "image" }],
  steps: [],
  agentNote:
    "the user's subject redrawn as one widescreen scene in one classic style picked from the film styles (a medium and technique, such as woodcut, impasto oil or silent-film black and white), the subject recognisable at a glance in the scene the user writes, drawn in that style; read the template with a style to get that style's words",
  goal: "film-styles",
  triggers: {
    asks: ["redraw my picture as a woodcut, an oil painting or a print", "a classic art style for my subject"],
    offerWhen: ["the user wants their picture to look artistic and has not said which style"],
  },
};
