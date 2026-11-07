// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** Normal, a collision, everything freezes and rewinds; one person is not affected. */
export const TIME_FREEZE_REWIND: GenerationTemplate = {
  id: "time-freeze-rewind",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 20, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "person", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 20-second vertical spectacle in five beats: normal, a collision, everything freezes mid-air, the camera circles, everything rewinds; only the user's person moves through it unaffected",
  goal: "social-hooks",
  triggers: {
    asks: ["time stops", "freeze time", "rewind everything"],
    offerWhen: ["the user wants a spectacle that people watch to the end"],
  },
};
