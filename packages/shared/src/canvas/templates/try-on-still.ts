// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A still of the user's model wearing the user's garment, the garment's every detail kept. */
export const TRY_ON_STILL: GenerationTemplate = {
  id: "try-on-still",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "3:4" } },
  ],
  edges: [],
  inputs: [
    { key: "model", type: "image" },
    { key: "garment", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 3:4 full-body photo of the user's model wearing the user's garment: the face, hair and build kept, the garment's cut, colour, fabric and details kept, in a plain studio; for seeing clothes on a person before a shoot or a video; the user says what goes with the garment",
  goal: "fashion",
  triggers: {
    asks: ["try these clothes on", "put this on my model", "a try-on picture"],
    offerWhen: ["the user has a picture of clothes and no picture of anyone wearing them"],
  },
};
