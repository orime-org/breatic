// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** Three landscape shots with no people, the place itself the subject. */
export const LANDSCAPE_3_SHOT: GenerationTemplate = {
  id: "landscape-3-shot",
  anchor: "result",
  nodes: [
    {
      key: "result",
      role: "generate",
      type: "video",
      mode: "multi_shot",
      model: "gemini-omni-1.1-flash-text-to-video",
      params: { aspect_ratio: "16:9", duration: 9 },
      shots: [{ seconds: 3 }, { seconds: 3 }, { seconds: 3 }],
    },
  ],
  edges: [],
  inputs: [],
  steps: [],
  agentNote:
    "a 9-second widescreen landscape film in three 3-second shots with no people in them, a wide establishing shot, a closer look at one detail of the place and a slow closing shot, with the place's own sound; the user fills in the place, the time of day and the detail",
  goal: "cinematic",
  triggers: {
    asks: ["a landscape film", "establishing shots with no people"],
    offerWhen: ["the user needs empty shots of a place to open or close a video"],
  },
};
