// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A silent high-quality shot, then foley timed to what happens in it. */
export const CLIP_AMBIENCE_FOLEY: GenerationTemplate = {
  id: "clip-ambience-foley",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "kling-v3.0-4k-text-to-video", params: { aspect_ratio: "16:9", duration: 5, generate_audio: false } },
    { key: "foley", role: "generate", type: "audio", mode: "sfx", model: "hunyuan-video-foley", params: {} },
  ],
  edges: [
    { from: "result", to: "foley", into: "video" },
  ],
  inputs: [],
  steps: [],
  agentNote:
    "a 5-second silent shot with clear, audible contacts, then foley generated from that shot so each sound lands on its moment; the user generates the shot first and picks it into the foley node's video slot",
  goal: "sound",
  triggers: {
    asks: ["foley", "sound effects for a clip"],
    offerWhen: ["a video is made with its sound switched off", "the user's video has no sound"],
  },
};
