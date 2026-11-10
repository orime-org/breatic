// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Qwen3 TTS Voice Design on WaveSpeed (inner#1825 §8): a voice described in
 * words, one call straight to audio. The page's fields are `text`,
 * `voice_description` and `language`; the price is $0.005 per call up to 100
 * characters and the same rate per 100 characters past that
 * (https://wavespeed.ai/models/wavespeed-ai/qwen3-tts/voice-design).
 */

import { describe, expect, it } from "vitest";
import { shipped } from "../../../config/__tests__/shipped.js";
import { buildBody } from "../../body.js";
import { createProvider } from "../../../provider.js";
import type { EstimateInput } from "../../../pricing/estimate.js";

const MODEL = "qwen3-tts-voice-design";

const provider = createProvider({
  config: shipped(),
  keyOf: (name) => (name === "WAVESPEED_API_KEY" ? "k" : undefined),
  llmMaxRetries: 0,
  cleanText: (t) => t,
});

/**
 * The model's WaveSpeed binding.
 * @returns The binding.
 * @throws {Error} When the model has none.
 */
function binding(): NonNullable<ReturnType<typeof shipped>["media"]["models"][string]>["upstreams"][number] {
  const found = shipped().media.models[MODEL]?.upstreams.find((b) => b.upstream === "wavespeed");
  if (!found) throw new Error(`${MODEL} has no WaveSpeed binding`);
  return found;
}

/**
 * A run's estimate input for one line.
 * @param text - The line.
 * @returns The input.
 */
function line(text: string): EstimateInput {
  return {
    params: { voice_description: "A calm narrator", language: "auto" },
    prompt: text,
    durations: {},
    placeholders: [],
    durationsMissing: [],
  };
}

describe("qwen3-tts-voice-design", () => {
  it("is bound to WaveSpeed's voice-design endpoint", () => {
    expect(binding().model_id).toBe("wavespeed-ai/qwen3-tts/voice-design");
  });

  it("sends the line as text, the description and the language", () => {
    expect(
      buildBody(binding(), { params: { voice_description: "A calm narrator", language: "English" }, prompt: "Good evening." }),
    ).toEqual({ text: "Good evening.", voice_description: "A calm narrator", language: "English" });
  });

  it("prices a line of 100 characters or fewer at $0.005", async () => {
    for (const text of ["Hi.", "a".repeat(100)]) {
      const estimate = await provider.estimate(MODEL, line(text), { mode: "default" });
      expect(estimate?.usd, `${text.length} chars`).toBeCloseTo(0.005, 9);
    }
  });

  it("prices a longer line at $0.005 per 100 characters", async () => {
    const estimate = await provider.estimate(MODEL, line("a".repeat(250)), { mode: "default" });
    expect(estimate?.usd).toBeCloseTo(0.0125, 9);
  });
});
