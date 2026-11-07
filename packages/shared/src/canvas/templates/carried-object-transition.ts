// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** One object carries the view from scene A to scene B, the transition made by the object. */
export const CARRIED_OBJECT_TRANSITION: GenerationTemplate = {
  id: "carried-object-transition",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "first_last", model: "seedance-2.5-image-to-video", params: { duration: 5, generate_audio: true } },
    { key: "scene-a", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "9:16" } },
    { key: "scene-b", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "9:16" } },
  ],
  edges: [
    { from: "scene-a", to: "result", into: "image" },
    { from: "scene-b", to: "result", into: "end_image" },
  ],
  inputs: [
    { key: "object", type: "image", feeds: ["scene-a", "scene-b"] },
  ],
  steps: [],
  agentNote:
    "a 5-second seamless transition: the user's object sits at the same place and size in two generated vertical scene pictures, which become the first and end frame of a video that follows the object from scene A into scene B; the user generates both scenes and picks them into the first and end frame before generating the video",
  goal: "social-hooks",
  triggers: {
    asks: ["a seamless transition", "a match cut between two places"],
    offerWhen: ["the user has two scenes or clips that need a transition between them"],
  },
};
