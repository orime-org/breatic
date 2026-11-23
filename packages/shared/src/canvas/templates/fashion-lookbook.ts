// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 15-second vertical lookbook: one model in one outfit through a few places, ending on the hero piece. */
export const FASHION_LOOKBOOK: GenerationTemplate = {
  id: "fashion-lookbook",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 15, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "model", type: "image" },
    { key: "outfit", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 15-second vertical lookbook video with sound: the user's model in the user's outfit, locked head to toe as in the pictures, walking through two or three places with the fabric moving, ending on a push-in to the hero piece and a tilt up to the face; the user names each piece, the places and the hero piece",
  goal: "fashion",
  triggers: {
    asks: ["a lookbook", "an outfit video", "a fashion video of my clothes"],
    offerWhen: ["the user has a picture of a model and a picture of clothes"],
  },
};
