// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The deciding instant freezes while the camera keeps circling, then the action carries on. */
export const BULLET_TIME_MOMENT: GenerationTemplate = {
  id: "bullet-time-moment",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "16:9", duration: 6 } },
  ],
  edges: [],
  inputs: [{ key: "hero", type: "image" }],
  steps: [],
  agentNote:
    "a 6-second widescreen bullet-time shot of the user's character: the action runs at full speed, freezes almost completely at the deciding instant while the camera keeps circling the frozen moment, then carries on at full speed; it is a freeze with a moving camera, not slow motion; the user fills in the action and the place",
  goal: "fight",
  triggers: {
    asks: ["bullet time", "freeze the action and spin around it"],
    offerWhen: ["a fight or a sports move in the user's work has one key instant worth holding"],
  },
};
