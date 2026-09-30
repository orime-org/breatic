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

import { listVoices, getVoice } from "../voice-catalog.js";
import { getFullModelConfig, resetModelCatalog } from "../model-catalog.js";
import { getVoiceSampleConfig } from "../voice-sample-config.js";

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
  it("serves the model's own table", async () => {
    const page = await listVoices("elevenlabs-v3", {});
    expect(page.hasMore).toBe(false);
    // Against the yaml rather than against zero: this table IS the product
    // surface, so serving one of its rows and serving all of them have to be
    // told apart.
    expect(page.voices.map((v) => v.id)).toEqual(declaredIds("elevenlabs-v3"));
    // Every row carries the sample the upstream publishes for it, which is the
    // play button in the picker.
    for (const voice of page.voices) {
      expect(voice.previewUrl, voice.id).toMatch(/^https:\/\/\S+$/);
    }
  });

  it("serves the system voices a model lists as ids", async () => {
    const page = await listVoices("minimax-speech-2.8-hd", {});
    expect(page.voices.map((v) => v.id)).toEqual(declaredIds("minimax-speech-2.8-hd"));
    expect(page.voices.map((v) => v.id)).toContain("Wise_Woman");
  });

  // By name, which is the only part of a row a person reads. Searching the
  // ids too would answer "a" with every voice whose opaque id contains one.
  // Three vendors publish no sample, so ours is generated once per voice and
  // served from one fixed address every deployment reads (#2239): the yaml
  // names the key, config/voice-samples.json names the address.
  it("gives every voice of the models without a vendor sample one of ours", async () => {
    const base = getVoiceSampleConfig().base_url.replace(/[.]/g, "\\.");
    for (const model of ["realtime-tts-2", "gemini-3.1-flash-text-to-speech", "minimax-speech-2.8-hd"]) {
      const page = await listVoices(model, {});
      for (const voice of page.voices) {
        expect(voice.previewUrl, `${model}/${voice.id}`).toMatch(
          new RegExp(`^${base}/voice-samples/${model}/(?:[a-zA-Z-]+/)?[A-Za-z0-9_-]+\\.mp3$`),
        );
      }
    }
  });

  it("speaks a one-language voice's sample in that language", async () => {
    // User 2026-09-29: a Portuguese voice saying its sample in English tells
    // the reader nothing. A non-English sample sits under its language tag.
    const minimax = await listVoices("minimax-speech-2.8-hd", {});
    const mandarin = minimax.voices.filter((v) => v.id.startsWith("Chinese (Mandarin)_"));
    expect(mandarin.length).toBeGreaterThan(0);
    for (const voice of mandarin) expect(voice.previewUrl, voice.id).toContain("/zh/");
    const inworld = await listVoices("realtime-tts-2", {});
    expect(inworld.voices.find((v) => v.id === "Hyunwoo")?.previewUrl).toContain("/ko/");
  });

  it("gives every Gemini voice a sample in every language the model declares", async () => {
    // Gemini's voices speak whichever language the reader picks in the panel.
    const model = getFullModelConfig("tts").models.find((m) => m.name === "gemini-3.1-flash-text-to-speech");
    const languages = model?.params?.language?.values ?? [];
    expect(languages.length).toBeGreaterThan(0);
    const page = await listVoices("gemini-3.1-flash-text-to-speech", {});
    for (const voice of page.voices) {
      expect(Object.keys(voice.previewUrls ?? {}).sort(), voice.id).toEqual([...languages].sort());
    }
  });

  it("filters that table by the search term", async () => {
    const page = await listVoices("elevenlabs-v3", { query: "ali" });
    expect(page.voices.map((v) => v.name)).toContain("Alice");
    expect(page.voices.every((v) => v.name.toLowerCase().includes("ali"))).toBe(true);
  });
});

describe("getVoice", () => {
  it("reads a single voice out of the same table", async () => {
    const alice = (await listVoices("elevenlabs-v3", { query: "Alice" })).voices[0];
    expect(alice).toBeDefined();
    expect((await getVoice("elevenlabs-v3", alice!.id))?.name).toBe("Alice");
  });

  it("answers null for an id that table does not carry", async () => {
    expect(await getVoice("elevenlabs-v3", "NoSuchVoiceIdAtAll")).toBeNull();
  });
});

// Every refusal carries the status the client should see, so the route hands
// it straight to the error handler rather than re-deriving one from a message.
describe("when there are no voices to answer with", () => {
  it("answers 404 for a model the catalog does not have", async () => {
    await expect(listVoices("no-such-model", {})).rejects.toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
  });

  it("answers 404 for a model whose params declare no voice source", async () => {
    await expect(listVoices("midjourney", {})).rejects.toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
  });
});
