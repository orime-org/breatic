// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** A short-drama episode of three scenes played from one script, the cast sheet keeping the main character the same. */
export const SHORT_DRAMA_EPISODE: GenerationTemplate = {
  id: "short-drama-episode",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "video", mode: "ref", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 15, generate_audio: true } },
    { key: "script", role: "written", type: "text" },
    { key: "cast", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9" } },
    { key: "scene-2", role: "generate", type: "video", mode: "ref", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 15, generate_audio: true } },
    { key: "scene-3", role: "generate", type: "video", mode: "ref", model: "seedance-2.5-text-to-video", params: { aspect_ratio: "9:16", duration: 15, generate_audio: true } },
  ],
  edges: [
    { from: "script", to: "result", into: "pool" },
    { from: "script", to: "scene-2", into: "pool" },
    { from: "script", to: "scene-3", into: "pool" },
    { from: "cast", to: "result", into: "pool" },
    { from: "cast", to: "scene-2", into: "pool" },
    { from: "cast", to: "scene-3", into: "pool" },
    { from: "result", to: "scene-2", into: "pool" },
    { from: "scene-2", to: "scene-3", into: "pool" },
  ],
  inputs: [{ key: "character", type: "image", feeds: ["cast"] }],
  steps: ["more", "join"],
  agentNote:
    "a vertical short-drama episode of three 15-second scenes with sound, played from one script: the script is a text node holding the title, the characters, the place and light and what happens in each scene, wired into every scene and @'d in each prompt; a cast sheet of the user's main character is generated first and goes into every scene's pool; each scene plays only its own part of the script, and scenes 2 and 3 also take the scene before into their pool and carry straight on from its last frame; for more scenes, add them to the script and copy the last scene node; the scenes are joined in order at the end; the script holds the user's story, scene by scene",
  goal: "drama",
  triggers: {
    asks: ["a short drama episode", "a drama in several scenes", "a whole short-drama story"],
    offerWhen: ["the user's story runs longer than one scene or 30 seconds"],
  },
};
