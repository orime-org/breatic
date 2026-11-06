// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A vlog that looks really shot on a phone: hand shake, focus hunting, no filters. */
export const PHONE_VLOG_REALISM: GenerationTemplate = {
  id: "phone-vlog-realism",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 15, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "person", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 15-second vertical day-in-the-life or get-ready-with-me vlog of the reader's person that looks really shot on a phone: hand shake, focus hunting, exposure jumps, no stabilisation, beauty filter or grade, chest-up framing, skin pores kept",
  goal: "social-hooks",
  triggers: {
    asks: ["a vlog", "a day in my life", "make it look real, like shot on a phone"],
    offerWhen: ["the reader says the videos they generated look too fake, too polished or too AI"],
  },
};
