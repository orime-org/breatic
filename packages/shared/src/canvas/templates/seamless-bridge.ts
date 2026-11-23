// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A transition shot generated between two clips the user already has, then joined with them into one video. */
export const SEAMLESS_BRIDGE: GenerationTemplate = {
  id: "seamless-bridge",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "16:9", duration: 5, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "clip-a", type: "video" },
    { key: "clip-b", type: "video" },
  ],
  steps: ["join"],
  agentNote:
    "a 5-second widescreen transition with sound generated between two clips the user already has, both wired into the pool: it starts on the first clip's last frame and lands on the second clip's first frame through a matching shape or something passing close to the lens, then the user joins clip A, the transition and clip B in that order; neither original is changed",
  goal: "video-remix",
  triggers: {
    asks: ["join these two clips smoothly", "a transition between two videos"],
    offerWhen: ["the user wants to put two clips with different places or looks one after the other"],
  },
};
