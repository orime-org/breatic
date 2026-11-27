// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A model sheet for each fighter first, then the duel, so both still look like themselves after the fight. */
export const FIGHT_DUEL_LOCKED: GenerationTemplate = {
  id: "fight-duel-locked",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "ref", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "16:9", duration: 15, generate_audio: true } },
    { key: "sheet-a", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "4:3" } },
    { key: "sheet-b", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "4:3" } },
  ],
  edges: [
    { from: "sheet-a", to: "result", into: "pool" },
    { from: "sheet-b", to: "result", into: "pool" },
  ],
  inputs: [
    { key: "fighter-a", type: "image", feeds: ["sheet-a"] },
    { key: "fighter-b", type: "image", feeds: ["sheet-b"] },
  ],
  steps: [],
  agentNote:
    "a model sheet of each of the user's two fighters is generated first (front, side and back full body plus a face close-up, each sheet showing only its own fighter), then both sheets go into the pool of a 15-second widescreen one-take duel written like the one-take duel, so faces and outfits hold through the fight; the user fills in the place, the moves and the deciding blow",
  goal: "fight",
  triggers: {
    asks: ["keep the fighters looking the same", "a fight where the characters don't change"],
    offerWhen: ["the user is making several fight clips, or has said the characters' faces changed in a fight"],
  },
};
