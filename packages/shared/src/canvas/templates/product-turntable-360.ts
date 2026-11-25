// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A turntable showcase built from three angles of one product, ending on its main angle. */
export const PRODUCT_TURNTABLE_360: GenerationTemplate = {
  id: "product-turntable-360",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "1:1", duration: 10, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "front", type: "image" },
    { key: "side", type: "image" },
    { key: "back", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 10-second square turntable showcase from three photos of one product (front, side, back): it lights up out of darkness on its front, turns slowly, pushes in to a close detail and comes to rest on the front again; the user fills in the turning pace for the kind of product and the detail to show",
  goal: "product-showcase",
  triggers: {
    asks: ["a 360 product video", "a turntable showcase"],
    offerWhen: ["the user adds several photos of the same product from different angles"],
  },
};
