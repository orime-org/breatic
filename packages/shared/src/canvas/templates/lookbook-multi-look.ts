// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** Three outfits, each tried on first as a still, then one 15-second lookbook changing through them. */
export const LOOKBOOK_MULTI_LOOK: GenerationTemplate = {
  id: "lookbook-multi-look",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 15, generate_audio: true } },
    { key: "look-1", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "9:16" } },
    { key: "look-2", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "9:16" } },
    { key: "look-3", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "9:16" } },
  ],
  edges: [
    { from: "look-1", to: "result", into: "pool" },
    { from: "look-2", to: "result", into: "pool" },
    { from: "look-3", to: "result", into: "pool" },
  ],
  inputs: [
    { key: "model", type: "image", feeds: ["look-1", "look-2", "look-3", "result"] },
    { key: "outfit-1", type: "image", feeds: ["look-1"] },
    { key: "outfit-2", type: "image", feeds: ["look-2"] },
    { key: "outfit-3", type: "image", feeds: ["look-3"] },
  ],
  steps: ["more"],
  agentNote:
    "a 15-second vertical lookbook video with sound changing the user's model through three outfits, each outfit tried on first as a still that goes into the video's pool with the model picture, each change hidden by a spin, a flash cut or a light change, each look a clearly different silhouette; when the user has more than three outfits, add a try-on still per extra outfit as an ordinary node on the same model fed by the model and that outfit, into the video's pool, and lengthen the video",
  goal: "fashion",
  triggers: {
    asks: ["several outfits in one video", "a multi-look lookbook", "an outfit change lookbook"],
    offerWhen: ["the user gives two or more outfits"],
  },
};
