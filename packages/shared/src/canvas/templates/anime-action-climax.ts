// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The user's character in an anime fight climax: a charge-up aura, speed lines, an impact frame. */
export const ANIME_ACTION_CLIMAX: GenerationTemplate = {
  id: "anime-action-climax",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "16:9", duration: 10, generate_audio: true } },
  ],
  edges: [],
  inputs: [{ key: "hero", type: "image" }],
  steps: [],
  agentNote:
    "a 10-second widescreen anime action climax of the user's character, cel-shaded with limited animation: a charge-up aura, a dash with speed lines in place of motion blur, an impact frame with a cross-shaped flash, then a final pose, key poses held half a second to a second; the user fills in the setting and the move",
  goal: "animation",
  triggers: {
    asks: ["an anime fight scene", "a hype anime battle"],
    offerWhen: ["the user's anime character has a fight in the story"],
  },
};
