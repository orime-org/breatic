// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A first-person walk in one continuous shot, from a start to a reveal. */
export const POV_CONTINUOUS_SHOT: GenerationTemplate = {
  id: "pov-continuous-shot",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 12, generate_audio: true } },
  ],
  edges: [],
  inputs: [],
  steps: [],
  agentNote:
    "a 12-second vertical first-person walk in one continuous take, the camera at eye height on the walker's head, no cuts and no zoom, ending on what is revealed at the destination; needs the place, the way and the reveal",
  goal: "social-hooks",
  triggers: {
    asks: ["a first-person video", "a POV shot", "one continuous take"],
    offerWhen: [],
  },
};
