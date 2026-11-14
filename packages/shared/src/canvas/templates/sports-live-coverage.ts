// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A game-show or sports run shot as live coverage, each camera with one job and every contact with its cause. */
export const SPORTS_LIVE_COVERAGE: GenerationTemplate = {
  id: "sports-live-coverage",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "16:9", duration: 12, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "athlete", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 12-second 16:9 live sports or game-show broadcast of the user's athlete through a course the user names: a wide crane shot of the course, a side tracking shot, a low shot of the contact, a finish camera; nobody reacts before contact, crowd and commentator react after each event",
  goal: "speed",
  triggers: {
    asks: ["a sports broadcast-style video", "a game show obstacle run"],
    offerWhen: [],
  },
};
