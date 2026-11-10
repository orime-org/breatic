// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A deadpan comedy skit built back from one visible punchline. */
export const TWIST_COMEDY_SKIT: GenerationTemplate = {
  id: "twist-comedy-skit",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 15, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "character", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 15-second vertical comedy skit with the user's character, shot completely straight, in six beats built back from the punchline: hook, setup, countdown, twist, reaction, button; needs a punchline and the beats",
  goal: "social-hooks",
  triggers: {
    asks: ["a funny skit", "a twist ending joke", "a comedy short"],
    offerWhen: ["the user wants to make a meme or a joke video"],
  },
};
