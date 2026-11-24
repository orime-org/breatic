// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 15-second listing walkthrough from four photos: approach, entry, living room, kitchen, bedroom view. */
export const LISTING_WALKTHROUGH_15S: GenerationTemplate = {
  id: "listing-walkthrough-15s",
  anchor: "result",
  nodes: [
    {
      key: "result",
      role: "generate",
      type: "video",
      mode: "multi_shot",
      model: "seedance-2.5-text-to-video",
      params: { aspect_ratio: "16:9", duration: 15, generate_audio: true },
      shots: [{ seconds: 3 }, { seconds: 3 }, { seconds: 3 }, { seconds: 3 }, { seconds: 3 }],
    },
  ],
  edges: [],
  inputs: [
    { key: "exterior", type: "image" },
    { key: "living", type: "image" },
    { key: "kitchen", type: "image" },
    { key: "bedroom", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 15-second widescreen listing walkthrough in five 3-second shots from the user's four photos: a drone approach to the exterior, a threshold reveal into the living room, a gimbal slide through the kitchen, the bedroom, and a window reveal of the view, each room exactly as in its photo; the user fills in the home, the time of day and the view",
  goal: "spaces",
  triggers: {
    asks: ["a short listing video", "a property video from my photos"],
    offerWhen: ["the user uploads photos of several rooms of one home"],
  },
};
