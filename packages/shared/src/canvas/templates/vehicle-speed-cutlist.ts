// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The user's car or motorbike at speed: the machine stays one machine while the camera cuts every second. */
export const VEHICLE_SPEED_CUTLIST: GenerationTemplate = {
  id: "vehicle-speed-cutlist",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "16:9", duration: 12, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "vehicle", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 12-second 16:9 speed film of the user's car or motorbike in exactly 12 cuts, one a second on purpose, keep that rhythm: the vehicle stays the same model, colour and wheels in every cut while the camera does the moving, close-ups on tyres, suspension and exhaust, never on badges or dials; engine and road sound; the user's photo goes straight into the video's pool, which takes only the vehicle from it, so its background needs no edit first",
  goal: "speed",
  triggers: {
    asks: ["a car commercial", "a street racing video", "a motorcycle speed clip"],
    offerWhen: ["the user adds a photo of their car or motorbike"],
  },
};
