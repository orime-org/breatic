// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A narrated motion comic: a vertical strip of comic panels that moves panel by panel under a voice-over. */
export const NARRATED_MOTION_COMIC: GenerationTemplate = {
  id: "narrated-motion-comic",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "9:16", duration: 15 } },
    { key: "panels", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "9:16" } },
    { key: "narration", role: "generate", type: "audio", mode: "tts", model: "minimax-speech-2.8-hd", params: { emotion: "neutral" } },
  ],
  edges: [
    { from: "panels", to: "result", into: "pool" },
    { from: "narration", to: "result", into: "pool" },
  ],
  inputs: [{ key: "cast", type: "image", feeds: ["panels"] }],
  steps: ["more", "join"],
  agentNote:
    "a 15-second narrated motion comic, the narration-led kind of comic drama: a vertical strip of four comic panels in the series' art style is drawn from the cast sheet, and a narration of at most 15 seconds is read from the user's words; both go into the reference video's pool, and the video moves through the panels one after another with small movements inside each while the narration plays as its sound; for a longer story, copy the panels, narration and video nodes for each further part and join the videos in order; the user fills in the four panels and the narration",
  goal: "comic-drama",
  triggers: {
    asks: ["a motion comic with narration", "a narrated comic video", "a commentary-style manju"],
    offerWhen: ["the user wants a comic drama told by a narrator over still panels"],
  },
};
