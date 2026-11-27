// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** One character walking through four eras of film, each era a still generated first (inner#1817). */
export const ERA_WALKTHROUGH_MONTAGE: GenerationTemplate = {
  id: "era-walkthrough-montage",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "ref", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "16:9", duration: 12, generate_audio: true } },
    { key: "silent", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9" } },
    { key: "widescreen", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9" } },
    { key: "nineties", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9" } },
    { key: "today", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9" } },
  ],
  edges: [
    { from: "silent", to: "result", into: "pool" },
    { from: "widescreen", to: "result", into: "pool" },
    { from: "nineties", to: "result", into: "pool" },
    { from: "today", to: "result", into: "pool" },
  ],
  inputs: [{ key: "character", type: "image", feeds: ["silent", "widescreen", "nineties", "today", "result"] }],
  steps: [],
  agentNote:
    "a 12-second widescreen video with sound of the user's character walking through four eras of film in one continuous walk, each era about 3 seconds: a silent black-and-white film, a widescreen saturated colour epic, a 1990s film on grainy stock and today's digital cinema; each era is a still generated first and goes into the video's pool with the character picture; for anniversaries and looking-back pieces",
  goal: "film-styles",
  triggers: {
    asks: ["walk through the eras of film", "my character across a hundred years of cinema"],
    offerWhen: ["the user is making an anniversary or looking-back piece"],
  },
};
