// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";
import type { FullModelEntry, VoiceSampleConfig } from "@breatic/domain";

import { planVoiceSamples } from "@worker/voice-samples/plan.js";

const CONFIG: VoiceSampleConfig = {
  base_url: "https://samples.test",
  languages: {
    en: { text: "Hello.", boost: "English" },
    zh: { text: "Ni hao.", boost: "Chinese" },
    ja: { text: "Konnichiwa." },
  },
  extra_body: { minimax: { language_boost: "{boost}" } },
};

const MINIMAX = {
  name: "minimax",
  takes_prompt: true,
  prompt_upstream: "text",
  params: { voice_id: { fill: "remote", remote_source: "voices" } },
  voices: [
    { id: "English_Guy", name: "Guy", sample_key: "voice-samples/minimax/English_Guy.mp3" },
    { id: "Chinese (Mandarin)_Ada", name: "Ada", sample_key: "voice-samples/minimax/zh/Chinese_Mandarin_Ada.mp3" },
  ],
} as unknown as FullModelEntry;

const GEMINI = {
  name: "gemini",
  takes_prompt: true,
  prompt_upstream: "text",
  params: {
    language: { fill: "panel", values: ["English (United States)", "Japanese (Japan)"], value_locales: ["en-US", "ja-JP"] },
    voice_id: { fill: "remote", remote_source: "voices", upstream: "voice" },
  },
  voices: [
    {
      id: "Kore",
      name: "Kore",
      sample_key: "voice-samples/gemini/Kore.mp3",
      sample_keys: { "Japanese (Japan)": "voice-samples/gemini/ja/Kore.mp3" },
    },
  ],
} as unknown as FullModelEntry;

describe("planVoiceSamples", () => {
  it("speaks each one-language sample in the language its key names", () => {
    expect(planVoiceSamples([MINIMAX], CONFIG)).toEqual([
      {
        model: "minimax",
        key: "voice-samples/minimax/English_Guy.mp3",
        body: { text: "Hello.", voice_id: "English_Guy", language_boost: "English" },
      },
      {
        model: "minimax",
        key: "voice-samples/minimax/zh/Chinese_Mandarin_Ada.mp3",
        body: { text: "Ni hao.", voice_id: "Chinese (Mandarin)_Ada", language_boost: "Chinese" },
      },
    ]);
  });

  it("sends a many-language voice its language under the model's own language param", () => {
    expect(planVoiceSamples([GEMINI], CONFIG)).toEqual([
      { model: "gemini", key: "voice-samples/gemini/Kore.mp3", body: { text: "Hello.", voice: "Kore" } },
      {
        model: "gemini",
        key: "voice-samples/gemini/ja/Kore.mp3",
        body: { text: "Konnichiwa.", voice: "Kore", language: "Japanese (Japan)" },
      },
    ]);
  });

  it("makes a key the voice names twice once, speaking the language it names", () => {
    const shared = {
      ...GEMINI,
      voices: [
        {
          id: "Kore",
          name: "Kore",
          sample_key: "voice-samples/gemini/Kore.mp3",
          sample_keys: { "English (United States)": "voice-samples/gemini/Kore.mp3" },
        },
      ],
    } as unknown as FullModelEntry;
    expect(planVoiceSamples([shared], CONFIG)).toEqual([
      {
        model: "gemini",
        key: "voice-samples/gemini/Kore.mp3",
        body: { text: "Hello.", voice: "Kore", language: "English (United States)" },
      },
    ]);
  });

  it("refuses a key whose language has no sentence", () => {
    const stray = {
      ...MINIMAX,
      voices: [{ id: "x", name: "x", sample_key: "voice-samples/minimax/tlh/x.mp3" }],
    } as unknown as FullModelEntry;
    expect(() => planVoiceSamples([stray], CONFIG)).toThrow(/tlh/);
  });
});
