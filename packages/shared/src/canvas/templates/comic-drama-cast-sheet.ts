// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { GenerationTemplate } from "@shared/canvas/generation-templates.js";

/** The main characters of a comic drama drawn once in the series' art style, for every episode to take from. */
export const COMIC_DRAMA_CAST_SHEET: GenerationTemplate = {
  id: "comic-drama-cast-sheet",
  anchor: "result",
  nodes: [
    { key: "result", role: "generate", type: "image", mode: "i2i", model: "nano-banana-pro-edit-ultra", params: { aspect_ratio: "16:9" } },
  ],
  edges: [],
  inputs: [
    { key: "lead", type: "image" },
    { key: "partner", type: "image", optional: true },
  ],
  steps: [],
  agentNote:
    "the cast sheet a comic drama series is built on: the user's main characters redrawn in one chosen comic or anime art style, each from the front, side and back with a row of expressions, on a plain background; every episode, motion comic and voiced line of the series takes this sheet as its character reference, so it is made once before any episode; the user fills in the art style and who each character is",
  goal: "comic-drama",
  triggers: {
    asks: ["characters for my comic drama", "a cast sheet for my anime series"],
    offerWhen: ["the user starts a comic drama or anime-style series and has no cast sheet in that art style yet"],
  },
};
