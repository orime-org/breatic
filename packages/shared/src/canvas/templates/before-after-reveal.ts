// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A vertical social before-and-after from the user's two photos, the first two seconds cut as a hook. */
export const BEFORE_AFTER_REVEAL: GenerationTemplate = {
  id: "before-after-reveal",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "first_last", model: "seedance-2.5-image-to-video", params: { duration: 6, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "before", type: "image", into: "image" },
    { key: "after", type: "image", into: "end_image" },
  ],
  steps: [],
  agentNote:
    "a 6-second social before-and-after from the user's own two photos of the same place, picked into the first and end frame: a hook in the first two seconds, then the work happening with its own sound until the after state; for cleaning, makeovers and restorations; both photos should be vertical and from the same spot; the user fills in the work",
  goal: "spaces",
  triggers: {
    asks: ["a before and after video", "a transformation video from my two photos"],
    offerWhen: ["the user has a before photo and an after photo of the same place"],
  },
};
