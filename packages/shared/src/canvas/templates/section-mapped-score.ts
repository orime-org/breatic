// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** Music in four sections, one style, trimmed and joined with crossfades. */
export const SECTION_MAPPED_SCORE: GenerationTemplate = {
  id: "section-mapped-score",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "audio", mode: "t2m", model: "lyria-3-pro-music", params: {} },
    { key: "body", role: "generate", type: "audio", mode: "t2m", model: "lyria-3-pro-music", params: {} },
    { key: "reveal", role: "generate", type: "audio", mode: "t2m", model: "lyria-3-pro-music", params: {} },
    { key: "outro", role: "generate", type: "audio", mode: "t2m", model: "lyria-3-pro-music", params: {} },
  ],
  edges: [],
  inputs: [],
  steps: ["trim", "join"],
  agentNote:
    "a score in four sections, intro, body, reveal and outro, each generated on its own in the same genre, tempo and key at the length its part of the film needs; the user trims each to length and joins them in order with about a second of crossfade",
  goal: "sound",
  triggers: {
    asks: ["music in sections", "a score that follows the parts of a film"],
    offerWhen: ["the user's long video has clearly separate parts"],
  },
};
