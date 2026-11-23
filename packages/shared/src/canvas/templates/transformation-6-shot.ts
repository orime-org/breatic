// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** Fifteen seconds in six quick shots: calm, threat, trigger, transformation, reveal, aftermath. */
export const TRANSFORMATION_6_SHOT: GenerationTemplate = {
  id: "transformation-6-shot",
  anchor: "result",
  nodes: [
    {
      key: "result",
      role: "generate",
      type: "video",
      mode: "multi_shot",
      model: "seedance-2.5-text-to-video",
      params: { aspect_ratio: "16:9", duration: 15, generate_audio: true },
      shots: [{ seconds: 3 }, { seconds: 2 }, { seconds: 2 }, { seconds: 3 }, { seconds: 3 }, { seconds: 2 }],
    },
  ],
  edges: [],
  inputs: [{ key: "subject", type: "image" }],
  steps: [],
  agentNote:
    "a 15-second widescreen transformation in six quick shots with sound: calm, a threat, the trigger, the transformation itself, the reveal of the new form and the quiet after, the user's subject the same person before and after; the user fills in the place, the threat and what the subject becomes",
  goal: "cinematic",
  triggers: {
    asks: ["a transformation scene", "a power-up moment"],
    offerWhen: ["the user's story has a transformation or an awakening"],
  },
};
