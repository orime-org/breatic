// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The user's room before and after renovation as first and end frame, the change between them in one take. */
export const RENOVATION_BEFORE_AFTER: GenerationTemplate = {
  id: "renovation-before-after",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "first_last", model: "seedance-2.5-image-to-video", params: { duration: 8, generate_audio: true } },
    { key: "before", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9" } },
    { key: "after", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9" } },
  ],
  edges: [
    { from: "before", to: "after", into: "pool" },
    { from: "before", to: "result", into: "image" },
    { from: "after", to: "result", into: "end_image" },
  ],
  inputs: [{ key: "room", type: "image", feeds: ["before"] }],
  steps: [],
  agentNote:
    "an 8-second widescreen renovation reveal of the user's room: a picture of the room as it is now is made from their photo at the video's frame, the renovated room is edited from that picture with the same camera, perspective and walls, and the two become the first and end frame of one continuous take in which the room transforms; the user fills in the renovation and how the change moves",
  goal: "spaces",
  triggers: {
    asks: ["a before and after of my renovation", "show what this room could look like renovated"],
    offerWhen: ["the user uploads an old room and talks about renovating it"],
  },
};
