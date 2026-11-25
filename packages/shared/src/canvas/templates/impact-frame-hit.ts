// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** Two fighters trade blows, the deciding hit lands with a visual accent picked from four, then the aftermath. */
export const IMPACT_FRAME_HIT: GenerationTemplate = {
  id: "impact-frame-hit",
  anchor: "result",
  styles: "impact-accents",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "16:9", duration: 10, generate_audio: true }, styleWords: "accent" },
  ],
  edges: [],
  inputs: [
    { key: "fighter-a", type: "image" },
    { key: "fighter-b", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 10-second widescreen fight with sound between the user's two fighters built around one deciding hit, tied to one exact point of contact: at contact the picture takes one accent picked from the impact accents (a manga impact frame, a white flash, a negative flash or a black flash) for a split second while the silhouettes, the striking arm and the contact point stay readable, then the colour comes back and the aftermath plays out; read the template with an accent to get its words; the user fills in the place, the hit and what follows",
  goal: "fight",
  triggers: {
    asks: ["an impact frame", "make the hits feel powerful"],
    offerWhen: ["the user says their fight has no punch or the hits feel weak"],
  },
};
