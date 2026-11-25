// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A whole music video: a style board, the performer sheet in it, then four sections cut to the user's song, joined. */
export const MV_FULL: GenerationTemplate = {
  id: "mv-full",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9" } },
    { key: "style", role: "generate", type: "image", mode: "t2i", model: "gpt-image-2.5-sunburst-text-to-image", params: { aspect_ratio: "16:9" } },
    { key: "section-1", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "16:9", duration: 15 } },
    { key: "section-2", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "16:9", duration: 15 } },
    { key: "section-3", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "16:9", duration: 15 } },
    { key: "section-4", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "16:9", duration: 15 } },
  ],
  edges: [
    { from: "style", to: "result", into: "pool" },
    { from: "style", to: "section-1", into: "pool" },
    { from: "style", to: "section-2", into: "pool" },
    { from: "style", to: "section-3", into: "pool" },
    { from: "style", to: "section-4", into: "pool" },
    { from: "result", to: "section-1", into: "pool" },
    { from: "result", to: "section-2", into: "pool" },
    { from: "result", to: "section-3", into: "pool" },
    { from: "result", to: "section-4", into: "pool" },
  ],
  inputs: [{ key: "performer", type: "image" }],
  steps: ["trim", "more", "join"],
  agentNote:
    "a whole widescreen music video for the user's song: a style board is generated first, then this node, a sheet of the user's performer in that look, and both go into the pool of four video sections of up to 15 seconds each; the user cuts the song with Cut where its music really changes (verse, chorus, bridge, drop, outro), sets each section's duration to its piece, connects each piece to its section and @s it where that section's prompt asks, as the video model plays the clip it is given as the video's sound; a section takes no other section into its pool, as the model then makes up its own sound in place of the piece; one camera move per section, no text on screen; for more sections copy the last one; the sections are joined in order and the user checks the beats at the seams; the user fills in the song's mood, the look, the outfit and what each section shows",
  goal: "music-video",
  triggers: {
    asks: ["a full music video", "a music video for the whole song"],
    offerWhen: ["the user's song runs longer than 30 seconds and they want pictures for all of it"],
  },
};
