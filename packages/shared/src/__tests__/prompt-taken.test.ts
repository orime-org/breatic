// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Whether a run takes the prompt (breatic#1393): Mureka V9.5 Song takes no
 * style prompt when it composes from a melody, and the choice is a setting of
 * the Reference to Music mode alone, while params are stored per model across
 * modes.
 */

import { describe, expect, it } from "vitest";

import { promptTaken, sanitizeModelCatalog, type ModelEntry } from "@shared/index.js";

/** The parts of Mureka V9.5 Song this rule reads, as the catalog declares them. */
const MUREKA = {
  name: "mureka-v9.5-generate-song",
  takes_prompt: true,
  prompt_when: { equals: { compose_from: "references" } },
  params: {
    compose_from: { description: "", modes: ["a2m"], values: ["references", "melody"], default: "references", fill: "panel", label: "Compose from" },
    song: { description: "", accepts: "audio", modes: ["a2m"], fill: "canvas", when: { equals: { compose_from: "references" } } },
    melody: { description: "", accepts: "audio", modes: ["a2m"], fill: "canvas", when: { equals: { compose_from: "melody" } } },
  },
} as unknown as ModelEntry;

describe("promptTaken", () => {
  it("takes the prompt when the run composes from style and references", () => {
    expect(promptTaken(MUREKA, "a2m", { compose_from: "references" })).toBe(true);
  });

  it("takes the prompt when nothing is chosen, by the default", () => {
    expect(promptTaken(MUREKA, "a2m", {})).toBe(true);
  });

  it("takes no prompt when the run composes from a melody", () => {
    expect(promptTaken(MUREKA, "a2m", { compose_from: "melody" })).toBe(false);
  });

  it("takes the prompt in Text to Music although a melody was chosen in Reference to Music", () => {
    expect(promptTaken(MUREKA, "t2m", { compose_from: "melody" })).toBe(true);
  });

  it("follows takes_prompt for a model with no condition", () => {
    expect(promptTaken({ ...MUREKA, prompt_when: undefined } as ModelEntry, "a2m", { compose_from: "melody" })).toBe(true);
    expect(promptTaken({ ...MUREKA, takes_prompt: false, prompt_when: undefined } as ModelEntry, "a2m", {})).toBe(false);
  });
});

describe("prompt_when on the wire", () => {
  it("reaches the panel intact", () => {
    const wire = sanitizeModelCatalog({ image: [], video: [], audio: [MUREKA], tts: [], three_d: [] });
    expect(wire.audio[0]?.prompt_when).toEqual({ equals: { compose_from: "references" } });
  });
});
