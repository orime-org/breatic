// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 3x3 storyboard sheet of numbered panels with the user's character, ready to drive one video. */
export const STORYBOARD_SHEET_9: GenerationTemplate = {
  id: "storyboard-sheet-9",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9", resolution: "4k" } },
  ],
  edges: [],
  inputs: [
    { key: "character", type: "image" },
    { key: "setting", type: "image", optional: true },
  ],
  steps: [],
  agentNote:
    "one widescreen storyboard sheet of nine numbered panels in a 3x3 grid, the user's character the same in every panel, each panel one beat with its shot size and an action already under way, no timecodes, ready to be turned into one video of 15 to 30 seconds; the setting picture is optional and the panels invent a place when it is left empty; the user fills in the story's beats",
  goal: "comics-storyboards",
  triggers: {
    asks: ["a storyboard", "a shot board for my video"],
    offerWhen: ["the user wants a 15 to 30 second video in several beats and has no storyboard yet"],
  },
};
