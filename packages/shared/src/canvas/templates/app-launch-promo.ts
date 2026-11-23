// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 15-second app or SaaS launch ad built on the user's own screens, the device as the hero. */
export const APP_LAUNCH_PROMO: GenerationTemplate = {
  id: "app-launch-promo",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 15, generate_audio: true } },
  ],
  edges: [],
  inputs: [
    { key: "screen-1", type: "image" },
    { key: "screen-2", type: "image" },
    { key: "logo", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 15-second vertical launch ad for the user's app: the phone is the hero and shows the user's own two screenshots exactly, a 2-second hook as the phone appears, the screens shown in use, one benefit, and an end on the phone with the user's logo; no words on screen, as the user adds their copy afterwards; for a desktop or web product change the ratio to fit a laptop screen and the phone to a laptop; the user fills in the product, the benefit and the music",
  goal: "promo",
  triggers: {
    asks: ["an app promo video", "a product launch motion ad", "a video for my SaaS"],
    offerWhen: ["the user uploads screenshots of their app or software"],
  },
};
