// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A character photo split into front, side and back views, which then hold the character through one video scene. */
export const SINGLE_VIEW_REFS_SCENE: GenerationTemplate = {
  id: "single-view-refs-scene",
  anchor: "result",
  nodes: [
    {
      key: "result",
      role: "generate",
      type: "video",
      mode: "t2v",
      model: "seedance-2.5-text-to-video",
      params: { aspect_ratio: "16:9", duration: 10, generate_audio: true },
    },
    { key: "front", role: "generate", type: "image", mode: "i2i", model: "qwen-image-edit-multiple-angles", params: { horizontal_angle: 0 } },
    { key: "side", role: "generate", type: "image", mode: "i2i", model: "qwen-image-edit-multiple-angles", params: { horizontal_angle: 90 } },
    { key: "back", role: "generate", type: "image", mode: "i2i", model: "qwen-image-edit-multiple-angles", params: { horizontal_angle: 180 } },
  ],
  edges: [
    { from: "front", to: "result", into: "pool" },
    { from: "side", to: "result", into: "pool" },
    { from: "back", to: "result", into: "pool" },
  ],
  inputs: [{ key: "reference", type: "image", feeds: ["front", "side", "back", "result"] }],
  steps: [],
  agentNote:
    "a 10-second video scene of the character in one photo: the photo is first turned into separate front, side and back views, and the photo and the three views together keep the same person while they move, turn and are seen from other angles",
  goal: "character",
  triggers: {
    asks: ["keep my character the same in a video", "the same person acting in one scene"],
    offerWhen: [
      "the reader has one photo of a person and wants a video in which that person turns, walks or is seen from other angles",
    ],
  },
};
