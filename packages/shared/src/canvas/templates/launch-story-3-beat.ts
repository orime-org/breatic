// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A 12-second launch story cut to a score made first: the problem, the reveal, the payoff, one object carried through. */
export const LAUNCH_STORY_3_BEAT: GenerationTemplate = {
  id: "launch-story-3-beat",
  anchor: "result",
  nodes: [
    {
      key: "result",
      role: "generate",
      type: "video",
      mode: "multi_shot",
      model: "minimax-h3-reference-to-video",
      params: { aspect_ratio: "16:9", duration: 12 },
      shots: [{ seconds: 4 }, { seconds: 4 }, { seconds: 4 }],
    },
    { key: "score", role: "generate", type: "audio", mode: "t2m", model: "mureka-v9.5-generate-bgm", params: {} },
  ],
  edges: [],
  inputs: [{ key: "product", type: "image" }],
  steps: ["trim"],
  agentNote:
    "a 12-second widescreen launch story in three 4-second beats, the problem, the reveal of the user's product and the payoff, one object carried through all three and every cut on a hit of the music; the score is generated first beside the video, and as it comes out a few minutes long the user cuts 12 seconds of it with Cut, connects the cut clip to the video and @s it where the first shot asks, as the video model plays the clip it is given as the soundtrack; the user fills in the problem, the object and the payoff",
  goal: "promo",
  triggers: {
    asks: ["a launch video", "a new product launch"],
    offerWhen: ["the user wants to say why a new product is worth buying"],
  },
};
