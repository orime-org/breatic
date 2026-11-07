// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 15-second quick tip: the result first, three steps, then back to the start so it loops. */
export const VERTICAL_15S_QUICK_TIP: GenerationTemplate = {
  id: "vertical-15s-quick-tip",
  anchor: "result",
  nodes: [
    {
      key: "result",
      role: "generate",
      type: "video",
      mode: "multi_shot",
      model: "seedance-2.5-text-to-video",
      params: { aspect_ratio: "9:16", duration: 15, generate_audio: true },
      shots: [{ seconds: 3 }, { seconds: 3 }, { seconds: 3 }, { seconds: 3 }, { seconds: 3 }],
    },
  ],
  edges: [],
  inputs: [
    { key: "subject", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 15-second vertical how-to in five 3-second shots: the finished result first, three steps, then the same result again so the video loops; the user writes what it looks like when done and the three steps",
  goal: "social-hooks",
  triggers: {
    asks: ["a tutorial short", "a quick tip video", "show how to do something in 15 seconds"],
    offerWhen: ["the user wants to explain a method or a trick"],
  },
};
