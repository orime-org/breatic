// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 15-second single-take tour through the user's space, the light changing by area, ambient sound only. */
export const SPACE_TOUR_SINGLE_TAKE: GenerationTemplate = {
  id: "space-tour-single-take",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "ref", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "16:9", duration: 15, generate_audio: true } },
  ],
  edges: [],
  inputs: [{ key: "space", type: "image" }],
  steps: [],
  agentNote:
    "a 15-second widescreen single take moving steadily forward through the user's space as in the photo, each next area revealed at a threshold, the light changing by area, with only the room's own ambient sound; the user fills in the space and the route",
  goal: "spaces",
  triggers: {
    asks: ["a listing video of my space", "a walkthrough of this room"],
    offerWhen: ["the user uploads a photo of a room or a venue"],
  },
};
