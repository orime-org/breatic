// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** Instrumental music in the era and medium of a classic style the user picks (inner#1817). */
export const STYLE_SOUND_BED: GenerationTemplate = {
  id: "style-sound-bed",
  anchor: "result",
  styles: "film-styles",
  nodes: [{ key: "result", role: "generate", type: "audio", mode: "t2m", model: "lyria-3-pro-music", params: {}, styleWords: "sound" }],
  edges: [],
  inputs: [],
  steps: [],
  agentNote:
    "a music bed with no lyrics in the era and medium of one classic style picked from the film styles, such as 1920s jazz for an art deco poster or a 1930s hot dance band for a rubber-hose cartoon; the model does not keep to a length; read the template with a style to get that style's words",
  goal: "film-styles",
  triggers: {
    asks: ["music with the feel of an old era", "a period soundtrack for my styled shot"],
    offerWhen: ["the user has made a film style shot and it has no music yet"],
  },
};
