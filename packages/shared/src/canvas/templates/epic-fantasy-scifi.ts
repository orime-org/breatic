// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A large fantasy or science fiction scene, every entity in a paragraph of its own and the effect as a mechanism with rules. */
export const EPIC_FANTASY_SCIFI: GenerationTemplate = {
  id: "epic-fantasy-scifi",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "ref", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "16:9", duration: 15, generate_audio: true } },
  ],
  edges: [],
  inputs: [{ key: "hero", type: "image" }],
  steps: [],
  agentNote:
    "a 15-second widescreen fantasy or science fiction scene with sound starring the user's character, the hero, the world and the effect each written in a paragraph of its own: the effect as a mechanism with a visible source and rule, the spectacle carried by weather, light, cloth, water, fire and distant crowds; the user fills in the world, the effect and what the hero does",
  goal: "cinematic",
  triggers: {
    asks: ["an epic fantasy scene", "a sci-fi battle", "a big magic moment"],
    offerWhen: [],
  },
};
