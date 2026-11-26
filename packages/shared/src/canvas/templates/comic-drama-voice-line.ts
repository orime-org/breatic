// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A comic-drama character speaking a line in a voice of its own that stays the same from episode to episode. */
export const COMIC_DRAMA_VOICE_LINE: GenerationTemplate = {
  id: "comic-drama-voice-line",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "talking_head", model: "omnihuman-1.5", params: {} },
    { key: "line", role: "generate", type: "audio", mode: "voice_clone", model: "minimax-voice-clone", params: {} },
    {
      key: "sample",
      role: "generate",
      type: "audio",
      mode: "tts",
      model: "qwen3-tts-voice-design",
      params: { voice_description: "A young man in his early twenties, low and cold, clipped and unhurried, speaking close to the microphone" },
    },
  ],
  edges: [
    { from: "sample", to: "line", into: "audio" },
    { from: "line", to: "result", into: "audio" },
  ],
  inputs: [{ key: "character", type: "image", into: "image" }],
  steps: [],
  agentNote:
    "one line of a comic-drama character in a voice that stays the same across the series: a voice sample of five or six sentences, well over the 10 seconds a clone needs, is designed from a description of the character's voice, the line is read by cloning that sample, and the character's picture lip-syncs it with the line itself as its sound, however short; the sample is made once per character and reused for every later line, so for a new line copy only the line and video nodes; the lip-sync model takes no prompt, so the user fills in the voice description and the line",
  goal: "comic-drama",
  triggers: {
    asks: ["give my character a voice", "the same voice for my character in every episode"],
    offerWhen: ["the user's comic drama has a character speaking lines across several episodes"],
  },
};
