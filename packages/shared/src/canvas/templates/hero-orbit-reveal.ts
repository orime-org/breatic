// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A ground-level keyframe of the hero crouching, then a half orbit as they rise: an awakening, a comeback, an entrance. */
export const HERO_ORBIT_REVEAL: GenerationTemplate = {
  id: "hero-orbit-reveal",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "i2v", model: "seedance-2.5-image-to-video", params: { duration: 6, generate_audio: true } },
    { key: "keyframe", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9", resolution: "4k" } },
  ],
  edges: [{ from: "keyframe", to: "result", into: "image" }],
  inputs: [{ key: "hero", type: "image", feeds: ["keyframe"] }],
  steps: [],
  agentNote:
    "a 6-second widescreen hero moment with sound: a ground-level keyframe of the user's character down on one knee against strong backlight with debris in front is generated first and picked into the first frame, then the camera makes a half orbit at one distance and height with parallax while the character rises on the spot without turning with the camera; the user fills in the place and what the moment is",
  goal: "fight",
  triggers: {
    asks: ["a hero entrance", "a cool reveal shot of my character"],
    offerWhen: ["the user's story reaches an awakening, a comeback or a climax for one character"],
  },
};
