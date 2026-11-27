// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A vertical comic-drama episode of three voiced scenes played from one script, the cast sheet keeping characters and art style the same. */
export const COMIC_DRAMA_EPISODE: GenerationTemplate = {
  id: "comic-drama-episode",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 15, generate_audio: true } },
    { key: "script", role: "written", type: "text" },
    { key: "scene-2", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 15, generate_audio: true } },
    { key: "scene-3", role: "generate", type: "video", mode: "t2v", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 15, generate_audio: true } },
  ],
  edges: [
    { from: "script", to: "result", into: "pool" },
    { from: "script", to: "scene-2", into: "pool" },
    { from: "script", to: "scene-3", into: "pool" },
    { from: "result", to: "scene-2", into: "pool" },
    { from: "scene-2", to: "scene-3", into: "pool" },
  ],
  inputs: [{ key: "cast", type: "image", feeds: ["result", "scene-2", "scene-3"] }],
  steps: ["more", "join"],
  agentNote:
    "a vertical comic-drama episode of three 15-second voiced scenes in the series' comic or anime art style, played from one script: the script is a text node holding the episode title, the cast, the place and what happens in each scene with its lines, wired into every scene and @'d in each prompt; the series' cast sheet (made with the cast sheet template) goes into every scene's pool and fixes both the characters and the art style; scene 1 opens on its hook in the first three seconds, each scene turns once, and scene 3 stops on the cliffhanger that leads into the next episode; scenes 2 and 3 also take the scene before into their pool and carry on from its last frame; for more scenes, add them to the script and copy the last scene node; the scenes are joined in order at the end; the script holds the user's story",
  goal: "comic-drama",
  triggers: {
    asks: ["a comic drama episode", "an anime-style short drama", "an AI manju episode"],
    offerWhen: ["the user has a comic or anime cast sheet and a story to tell in episodes"],
  },
};
