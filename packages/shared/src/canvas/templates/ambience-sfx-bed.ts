// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** An ambience bed with a few foley hits that lays sound under a silent clip. */
export const AMBIENCE_SFX_BED: GenerationTemplate = {
  id: "ambience-sfx-bed",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "audio", mode: "sfx", model: "sfx-1.6-text-to-audio", params: { loop: true, duration: 30 } },
  ],
  edges: [],
  inputs: [],
  steps: [],
  agentNote:
    "a 30-second seamless ambience bed of one place with two or three foley hits in it, made to sit under a silent clip or a scene",
  goal: "sound",
  triggers: {
    asks: ["ambience", "sound effects", "a background sound bed"],
    offerWhen: ["the user's video has no sound"],
  },
};
