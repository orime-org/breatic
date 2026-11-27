// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The user's own comic page or strip set moving in its own drawn style, panel by panel. */
export const COMIC_PAGE_TO_MOTION: GenerationTemplate = {
  id: "comic-page-to-motion",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "ref", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "16:9", duration: 10, generate_audio: true } },
  ],
  edges: [],
  inputs: [{ key: "page", type: "image" }],
  steps: [],
  agentNote:
    "a 10-second widescreen motion comic of the user's own comic page, strip or storyboard: the camera moves across the panels in their reading order, the line work, colouring and screentone kept as drawn, the balloons deciding how lines are spoken, and transitions made on the paper itself (a page turn, an ink bleed); the user fills in the reading order and what moves",
  goal: "comics-storyboards",
  triggers: {
    asks: ["make my comic move", "turn my webtoon into a video"],
    offerWhen: ["the user adds a comic page or storyboard picture and mentions a video"],
  },
};
