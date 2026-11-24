// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A horror beat in one shot: ordinary, wrong, silent, then the reveal by light and sound. */
export const HORROR_SUSPENSE: GenerationTemplate = {
  id: "horror-suspense",
  anchor: "result",
  nodes: [{ key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "16:9", duration: 15, generate_audio: true } }],
  edges: [],
  inputs: [{ key: "character", type: "image" }],
  steps: [],
  agentNote:
    "a 15-second widescreen horror scene with sound around the user's character in one shot: an ordinary setup, one wrong detail, four seconds of silence with the camera creeping in, then a reveal made by light and sound only; the fear comes from shadow, one light and sound, never from blood, wounds or violence, as words for gore and injury get a video refused by the model's content check before it runs; the user fills in the place, the action, the wrong detail, the reveal and the light",
  goal: "drama",
  triggers: {
    asks: ["a horror scene", "a suspense or thriller scene", "something creepy"],
    offerWhen: [],
  },
};
