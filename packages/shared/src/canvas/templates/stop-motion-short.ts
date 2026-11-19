// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The user's object or character rebuilt in clay, paper or toys and moved in stop-motion steps. */
export const STOP_MOTION_SHORT: GenerationTemplate = {
  id: "stop-motion-short",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "1:1", duration: 8, generate_audio: true } },
  ],
  edges: [],
  inputs: [{ key: "subject", type: "image" }],
  steps: [],
  agentNote:
    "an 8-second square stop-motion short of the user's object or character rebuilt in clay, paper or tabletop toys, shot at 12 frames a second with each pose held two frames so it steps rather than glides, fingerprints left on the surfaces; the user fills in the material and what happens",
  goal: "animation",
  triggers: {
    asks: ["a stop-motion video", "a claymation clip"],
    offerWhen: [],
  },
};
