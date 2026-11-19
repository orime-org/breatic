// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** Each of four panels of the user's comic page becomes its own shot, timed one by one. */
export const COMIC_PANELS_TO_SHOTS: GenerationTemplate = {
  id: "comic-panels-to-shots",
  anchor: "result",
  nodes: [
    {
      key: "result",
      role: "generate",
      type: "video",
      mode: "multi_shot",
      model: "seedance-2.5-text-to-video",
      params: { aspect_ratio: "16:9", duration: 12, generate_audio: true },
      shots: [{ seconds: 3 }, { seconds: 3 }, { seconds: 3 }, { seconds: 3 }],
    },
  ],
  edges: [],
  inputs: [{ key: "page", type: "image" }],
  steps: [],
  agentNote:
    "a 12-second widescreen video of the user's comic page in four 3-second shots, one per panel in reading order, each shot keeping that panel's drawing, framing and style and moving only what the panel shows; for when panels blur into each other in a single take; the user fills in what moves in each panel",
  goal: "comics-storyboards",
  triggers: {
    asks: ["one shot per panel", "animate each panel separately"],
    offerWhen: ["the user's motion comic runs its panels together and they want each panel on its own"],
  },
};
