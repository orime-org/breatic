// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A short cartoon gag with the user's character: a crash entrance, a setup, an exaggerated reaction and a recovery. */
export const CARTOON_GAG: GenerationTemplate = {
  id: "cartoon-gag",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 5, generate_audio: true } },
  ],
  edges: [],
  inputs: [{ key: "character", type: "image" }],
  steps: [],
  agentNote:
    "a 5-second vertical cartoon gag starring the user's character in four timed beats (it crashes into frame, the setup, an exaggerated reaction, the recovery) with anticipation, squash and follow-through written in and cartoon sound effects; the user fills in the style, the situation, the setup and the gag",
  goal: "animation",
  triggers: {
    asks: ["a cartoon", "a funny animation"],
    offerWhen: ["the user has a cartoon character and wants a short gag with it"],
  },
};
