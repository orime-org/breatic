// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A whole music video: a style board, the performer in it and four sections cut to the user's song, joined. */
export const MV_FULL: GenerationTemplate = {
  id: "mv-full",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "16:9", duration: 15 } },
    { key: "style", role: "generate", type: "image", mode: "t2i", model: "gpt-image-2.5-sunburst-text-to-image", params: { aspect_ratio: "16:9" } },
    { key: "performer-sheet", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9" } },
    { key: "section-2", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "16:9", duration: 15 } },
    { key: "section-3", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "16:9", duration: 15 } },
    { key: "section-4", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "16:9", duration: 15 } },
  ],
  edges: [
    { from: "style", to: "performer-sheet", into: "pool" },
    { from: "style", to: "result", into: "pool" },
    { from: "style", to: "section-2", into: "pool" },
    { from: "style", to: "section-3", into: "pool" },
    { from: "style", to: "section-4", into: "pool" },
    { from: "performer-sheet", to: "result", into: "pool" },
    { from: "performer-sheet", to: "section-2", into: "pool" },
    { from: "performer-sheet", to: "section-3", into: "pool" },
    { from: "performer-sheet", to: "section-4", into: "pool" },
    { from: "result", to: "section-2", into: "pool" },
    { from: "section-2", to: "section-3", into: "pool" },
    { from: "section-3", to: "section-4", into: "pool" },
  ],
  inputs: [{ key: "performer", type: "image", feeds: ["performer-sheet"] }],
  steps: ["trim", "more", "join"],
  agentNote:
    "a whole widescreen music video for the user's song in four sections of up to 15 seconds: a style board is generated first, then a sheet of the user's performer in that look, and both go into every section's pool; each section after the first also takes the one before into its pool, for the same performer, wardrobe, look and light and never its sound; the user cuts the song with Cut where its music really changes (verse, chorus, bridge, drop, outro), each piece up to 15 seconds, sets each section's duration to its piece, connects each piece to its section and @s it where that section's prompt asks, as this model plays the clip it is given as the video's sound; one camera move per section, no text on screen; for more sections copy the last one; the sections are joined in order and the user checks the beats at the seams; the user fills in the song's mood, the look and what each section shows",
  goal: "music-video",
  triggers: {
    asks: ["a full music video", "a music video for the whole song"],
    offerWhen: ["the user's song runs longer than 30 seconds and they want pictures for all of it"],
  },
};
