// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The user's empty room furnished and styled, the walls, windows and camera unchanged. */
export const ROOM_STAGING_STILL: GenerationTemplate = {
  id: "room-staging-still",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "auto" } },
  ],
  edges: [],
  inputs: [{ key: "room", type: "image" }],
  steps: [],
  agentNote:
    "a virtual staging of the user's empty room: furniture, rugs, lighting and decor in one style, while the walls, windows, doors, floor, ceiling and camera position stay exactly as in the photo, at the photo's own ratio; the user fills in the style and what the room is for",
  goal: "spaces",
  triggers: {
    asks: ["virtual staging", "furnish this empty room", "show this room decorated"],
    offerWhen: ["the user uploads a photo of an empty room"],
  },
};
