// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** Six direct-flash snapshots of one person in a 3x2 grid, six expressions. */
export const FLASH_PHOTO_DUMP_GRID: GenerationTemplate = {
  id: "flash-photo-dump-grid",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "3:4" } },
  ],
  edges: [],
  inputs: [
    { key: "person", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 3:4 image of six direct-flash compact-camera snapshots of the reader's person in a 3 by 2 grid, one expression each; the photo is used only to know who they are",
  goal: "social-hooks",
  triggers: {
    asks: ["a photo dump", "flash snapshots", "a grid of candid photos"],
    offerWhen: [],
  },
};
