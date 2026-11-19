// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 15-second anime opening in five shots: the title moment, the lead, action cuts, the others, a group pose. */
export const ANIME_OPENING_15S: GenerationTemplate = {
  id: "anime-opening-15s",
  anchor: "result",
  nodes: [
    {
      key: "result",
      role: "generate",
      type: "video",
      mode: "multi_shot",
      model: "seedance-2.5-text-to-video",
      params: { aspect_ratio: "16:9", duration: 15, generate_audio: true },
      shots: [{ seconds: 3 }, { seconds: 3 }, { seconds: 3 }, { seconds: 3 }, { seconds: 3 }],
    },
  ],
  edges: [],
  inputs: [
    { key: "lead", type: "image" },
    { key: "second", type: "image" },
    { key: "third", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 15-second widescreen anime opening in five 3-second shots: a burst of colour leaving room for a title added later, the lead's entrance, action cuts, the two others' entrances, and a group pose, the three characters from the user's pictures drawn in one anime style over an upbeat opening song; the user fills in the mood, where the lead appears, the lead's action and the backdrop",
  goal: "animation",
  triggers: {
    asks: ["an anime opening", "an intro sequence for my characters"],
    offerWhen: ["the user has two or three characters and wants an opening for them"],
  },
};
