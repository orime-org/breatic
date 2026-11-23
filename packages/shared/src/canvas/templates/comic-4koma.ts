// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A four-panel vertical comic strip: setup, build-up, twist and punchline. */
export const COMIC_4KOMA: GenerationTemplate = {
  id: "comic-4koma",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "9:16", resolution: "4k" } },
  ],
  edges: [],
  inputs: [{ key: "character", type: "image" }],
  steps: [],
  agentNote:
    "one vertical four-panel comic strip with the user's character, one beat per panel (setup, build-up, twist, punchline), the last panel holding on the reaction and the speech balloons left empty for lettering added later; the user fills in the four beats",
  goal: "comics-storyboards",
  triggers: {
    asks: ["a four-panel comic", "a 4-koma strip"],
    offerWhen: ["the user wants a short joke or twist told as a comic"],
  },
};
