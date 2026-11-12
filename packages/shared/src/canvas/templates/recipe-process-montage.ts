// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A dish made step by step from a fixed camera, ending on one lived-in beat with the finished dish. */
export const RECIPE_PROCESS_MONTAGE: GenerationTemplate = {
  id: "recipe-process-montage",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 15, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "dish", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 15-second vertical video of the user's finished dish being made from a fixed camera: the same counter, cookware and hands throughout, four steps the user names in five 3-second beats, each state only moving forward, ending on one lived-in beat with the finished dish served; live kitchen sounds",
  goal: "food",
  triggers: {
    asks: ["a cooking process video", "a recipe tutorial video", "show how a dish is made"],
    offerWhen: ["the user wants to show how to make a dish"],
  },
};
