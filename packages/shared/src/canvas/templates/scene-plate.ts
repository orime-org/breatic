// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The empty place a drama is set in, to wire into every scene played there. */
export const SCENE_PLATE: GenerationTemplate = {
  id: "scene-plate",
  anchor: "result",
  nodes: [{ key: "result", role: "generate", type: "image", mode: "t2i", model: "gpt-image-2.5-sunburst-text-to-image", params: { aspect_ratio: "16:9" } }],
  edges: [],
  inputs: [],
  steps: [],
  agentNote:
    "a 16:9 widescreen picture of the empty place a drama is set in, no people: floor, walls, key furniture and props and one light source with where its light falls, at eye level with a wide lens and everything in focus, to wire into the pool of every scene played there so the place stays the same; the user fills in the place, the props and the light",
  goal: "drama",
  triggers: {
    asks: ["a scene or location picture", "a set design for my story"],
    offerWhen: ["the user is about to make several scenes in one place and has no picture of it yet"],
  },
};
