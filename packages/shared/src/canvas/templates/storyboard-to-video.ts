// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A six-panel storyboard sheet first, then a video that plays its panels in order. */
export const STORYBOARD_TO_VIDEO: GenerationTemplate = {
  id: "storyboard-to-video",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "16:9", duration: 15, generate_audio: true } },
    { key: "sheet", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9" } },
  ],
  edges: [{ from: "sheet", to: "result", into: "pool" }],
  inputs: [{ key: "character", type: "image", feeds: ["sheet", "result"] }],
  steps: [],
  agentNote:
    "a 15-second widescreen video told from a storyboard: a six-panel sheet with the user's character is generated first and goes into the video's pool with the character picture, then the video plays the panels in order, each panel one shot of about 2.5 seconds, the character picture deciding the face and clothes and the sheet deciding place, action, framing and order; the user fills in the story's six beats",
  goal: "comics-storyboards",
  triggers: {
    asks: ["a video from my storyboard", "turn the storyboard into a video"],
    offerWhen: ["the user already has a storyboard picture, or the story has more than three beats"],
  },
};
