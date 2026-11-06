// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A traveler walks through a city scene by scene and ends at a viewpoint at golden hour. */
export const TRAVEL_CITY_WALK: GenerationTemplate = {
  id: "travel-city-walk",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 24, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "traveler", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 24-second vertical travel vlog of the reader's traveler walking through a city the reader names, five scenes of about 4 seconds each and an ending at a viewpoint at golden hour, the same face and outfit throughout",
  goal: "social-hooks",
  triggers: {
    asks: ["a travel vlog", "a city walk", "a video of my trip"],
    offerWhen: ["the reader mentions a city or a trip"],
  },
};
