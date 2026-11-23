// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A calm or story video of a minute and more, in acts of up to 30 seconds each, joined into one. */
export const LONG_FORM_ACTS: GenerationTemplate = {
  id: "long-form-acts",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "16:9", duration: 30, generate_audio: true } },
    { key: "act-2", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "16:9", duration: 30, generate_audio: true } },
    { key: "act-3", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "16:9", duration: 30, generate_audio: true } },
  ],
  edges: [],
  inputs: [],
  steps: ["more", "join"],
  agentNote:
    "a widescreen video of about 90 seconds with sound in three acts of 30 seconds, generated one by one in the same place, light, look and sound and joined in order, for calm ambience, nature or a short story; every act repeats the same shared description and adds what happens in it; when the user wants it longer than 90 seconds, add more acts as ordinary nodes on the same model with the same shared description, up to 30 seconds each",
  goal: "cinematic",
  triggers: {
    asks: ["a one or two minute video", "a long ambience video"],
    offerWhen: ["the user wants a video longer than 30 seconds"],
  },
};
