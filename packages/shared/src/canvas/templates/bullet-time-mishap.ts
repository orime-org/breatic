// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A clumsy moment frozen mid-air while the camera circles it 360 degrees. */
export const BULLET_TIME_MISHAP: GenerationTemplate = {
  id: "bullet-time-mishap",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 8, generate_audio: true } },
  ],
  edges: [],
  inputs: [],
  steps: [],
  agentNote:
    "an 8-second vertical clip of a clumsy moment (a slip, a cat knocking a glass over) that freezes at its worst instant while the camera circles it 360 degrees, then finishes; the user only writes who and what goes wrong",
  goal: "social-hooks",
  triggers: {
    asks: ["bullet time", "freeze the moment it goes wrong"],
    offerWhen: ["the user wants a funny freeze-frame moment"],
  },
};
