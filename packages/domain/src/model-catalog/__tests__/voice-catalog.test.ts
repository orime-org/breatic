// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1960 A2 — the voice list a tts model offers.
 *
 * Every tts model runs on WaveSpeed, which has no voice endpoint to ask, so
 * the list is the one each model's yaml entry carries. The id handed back is
 * the value the upstream accepts, which is what ends up in the node's params
 * and travels back out on the next generation.
 */

import { describe, it, expect, afterAll } from "vitest";
import { initCore } from "@breatic/core";

const { listVoices, getVoice } = await import("../voice-catalog.js");
const { getFullModelConfig, resetModelCatalog } = await import("../model-catalog.js");

initCore({ DATABASE_URL: "postgres://localhost:5432/breatic_test" });
resetModelCatalog();

afterAll(() => {
  initCore(process.env);
  resetModelCatalog();
});

/**
 * The voices a tts model lists in its yaml entry.
 * @param model - The model's catalog name.
 * @returns The declared voice ids, in file order.
 */
function declaredIds(model: string): string[] {
  const entry = getFullModelConfig("tts").models.find((m) => m.name === model);
  return (entry?.voices ?? []).map((v) => v.id);
}

describe("listVoices", () => {
  it("serves the model's own table", () => {
    const page = listVoices("elevenlabs-v3", {});
    expect(page.hasMore).toBe(false);
    // Against the yaml rather than against zero: this table IS the product
    // surface, so serving one of its rows and serving all of them have to be
    // told apart.
    expect(page.voices.map((v) => v.id)).toEqual(declaredIds("elevenlabs-v3"));
    // Every row carries the sample the upstream publishes for it, which is the
    // play button in the picker.
    for (const voice of page.voices) {
      expect(voice.previewUrl, voice.id).toMatch(/^https:\/\/\S+\.mp3$/);
    }
  });

  it("serves the system voices a model lists as ids", () => {
    const page = listVoices("minimax-speech-2.8-hd", {});
    expect(page.voices.map((v) => v.id)).toEqual(declaredIds("minimax-speech-2.8-hd"));
    expect(page.voices.map((v) => v.id)).toContain("Wise_Woman");
  });

  // By name, which is the only part of a row a person reads. Searching the
  // ids too would answer "a" with every voice whose opaque id contains one.
  it("filters that table by the search term", () => {
    const page = listVoices("elevenlabs-v3", { query: "ali" });
    expect(page.voices.map((v) => v.name)).toContain("Alice");
    expect(page.voices.every((v) => v.name.toLowerCase().includes("ali"))).toBe(true);
  });
});

describe("getVoice", () => {
  it("reads a single voice out of the same table", () => {
    const alice = listVoices("elevenlabs-v3", { query: "Alice" }).voices[0];
    expect(alice).toBeDefined();
    expect(getVoice("elevenlabs-v3", alice!.id)?.name).toBe("Alice");
  });

  it("answers null for an id that table does not carry", () => {
    expect(getVoice("elevenlabs-v3", "NoSuchVoiceIdAtAll")).toBeNull();
  });
});

// Every refusal carries the status the client should see, so the route hands
// it straight to the error handler rather than re-deriving one from a message.
describe("when there are no voices to answer with", () => {
  it("answers 404 for a model the catalog does not have", () => {
    expect(() => listVoices("no-such-model", {})).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
  });

  it("answers 404 for a model whose params declare no voice source", () => {
    expect(() => listVoices("midjourney", {})).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
  });
});
