// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A new video in the spirit of one the user brings: its camera moves and rhythm, the user's own subject, nothing copied. */
export const REFERENCE_VIDEO_REMIX: GenerationTemplate = {
  id: "reference-video-remix",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "ref", model: "minimax-h3-reference-to-video", params: { aspect_ratio: "9:16", duration: 10 } },
  ],
  edges: [],
  inputs: [
    { key: "reference", type: "video" },
    { key: "subject", type: "image" },
  ],
  steps: [],
  agentNote:
    "a 10-second vertical video in the spirit of a video the user brings: it takes the reference's camera moves, shot order and rhythm and puts the user's own subject in it, never its performer, faces, clothes, place, logos, text or sound; before proposing it, break the reference down into its hook, shot structure, camera moves, pacing and look as far as the user or the video tells you, and offer two or three directions, each with one creative twist; when the user only wants their character to copy a person's exact body movement, the Motion transfer tool on the video does that directly",
  goal: "video-remix",
  triggers: {
    asks: ["make one like this video", "the same camera moves as this video"],
    offerWhen: ["the user brings someone else's popular video, as a file or a link, and wants their own version of it"],
  },
};
