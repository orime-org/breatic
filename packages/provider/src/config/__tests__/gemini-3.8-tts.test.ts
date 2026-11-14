// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Gemini 3.8 Flash TTS replaces 3.1 (#1521): bound to WaveSpeed, fal and SandBase, a dialogue sent as turns and kept
 * off SandBase, which serves one speaker only; 3.1 stays bound only so runs opened before the change finish.
 */

import { describe, expect, it } from "vitest";
import { buildBody } from "../../media/body.js";
import { RETIRED } from "../../media/wavespeed/__tests__/departures.js";
import { rejectedInput, type EstimateInput } from "../../pricing/estimate.js";
import { createProvider } from "../../provider.js";
import { catalog, shipped } from "./shipped.js";

const MODEL = "gemini-3.8-flash-text-to-speech";
const config = shipped();
const provider = createProvider({ config, keyOf: () => "k", llmMaxRetries: 0, cleanText: (t) => t });
const PAIR = [{ speaker: "Ava", voice: "Kore" }, { speaker: "Leo", voice: "Puck" }];

/**
 * A run as the application prepares it.
 * @param input - What differs from an empty run.
 * @returns The run.
 */
const run = (input: Partial<EstimateInput>): EstimateInput => ({ params: {}, prompt: "", durations: {}, placeholders: [], durationsMissing: [], ...input });

/**
 * What an upstream refuses of a run.
 * @param upstream - The upstream.
 * @param input - The run.
 * @returns What it refuses, if anything.
 */
const refused = (upstream: string, input: Partial<EstimateInput>): ReturnType<typeof rejectedInput> => rejectedInput(provider.pricingRules(MODEL), upstream, run(input));

/**
 * The model's binding on an upstream.
 * @param upstream - The upstream.
 * @returns The binding.
 */
const bindingOn = (upstream: string): NonNullable<(typeof provider.config.models)[string]>[number] => provider.config.models[MODEL]!.find((b) => b.upstream === upstream)!;

describe("Gemini 3.8 Flash TTS", () => {
  it("is bound to WaveSpeed, fal and SandBase in that order", () => {
    expect(provider.config.models[MODEL]!.map((b) => [b.upstream, b.weight, b.model_id])).toEqual([
      ["wavespeed", 1, "google/gemini-3.8-flash/text-to-speech"],
      ["fal", 2, "google/gemini-3.8-flash-tts"],
      ["sandbase", 3, "google/gemini-3.8-flash-tts"],
    ]);
  });

  it("is in the catalog with no language param", () => {
    const entry = catalog().models.find((m) => m.name === MODEL);
    expect(entry).toBeDefined();
    expect(entry!.params.language).toBeUndefined();
  });

  it("sends a dialogue to WaveSpeed and fal as speakers and turns, with no prompt", () => {
    for (const upstream of ["wavespeed", "fal"]) {
      expect(buildBody(bindingOn(upstream), { prompt: "Ava: Hi.\nLeo: Hello.", params: { speakers: PAIR, voice_id: "Kore" } })).toEqual({
        speakers: [{ speaker_id: "Ava", voice: "Kore" }, { speaker_id: "Leo", voice: "Puck" }],
        turns: [{ speaker_id: "Ava", text: "Hi." }, { speaker_id: "Leo", text: "Hello." }],
        voice: "Kore",
      });
    }
  });

  it("sends a single voice to each upstream as its prompt and voice", () => {
    expect(buildBody(bindingOn("wavespeed"), { prompt: "Hi.", params: { voice_id: "Kore" } })).toEqual({ text: "Hi.", voice: "Kore" });
    expect(buildBody(bindingOn("fal"), { prompt: "Hi.", params: { voice_id: "Kore" } })).toEqual({ prompt: "Hi.", voice: "Kore" });
    expect(buildBody(bindingOn("sandbase"), { prompt: "Hi.", params: { voice_id: "Kore" } })).toEqual({ prompt: "Hi.", voice: "Kore" });
  });

  it("keeps a dialogue off SandBase, which serves one speaker only, and takes a single voice there", async () => {
    expect(await refused("sandbase", { prompt: "Ava: Hi.", params: { speakers: PAIR } })).toEqual({ param: "speakers", value: PAIR });
    expect(await refused("sandbase", { prompt: "Hi.", params: { voice_id: "Kore" } })).toBeUndefined();
  });

  it("takes any named speaker on fal, whose 3.8 endpoint asks only for a non-empty id", async () => {
    expect(await refused("fal", { prompt: "Al ice: Hi.", params: { speakers: [{ speaker: "Al ice", voice: "Kore" }, { speaker: "李·明", voice: "Puck" }] } })).toBeUndefined();
  });

  it("keeps a script over 8000 characters off WaveSpeed, whose text field caps there", async () => {
    expect(await refused("wavespeed", { prompt: "x".repeat(8001) })).toEqual({ reason: expect.stringContaining("8000") });
    expect(await refused("wavespeed", { prompt: "x".repeat(8000) })).toBeUndefined();
  });

  it("keeps a dialogue of more than 100 lines off WaveSpeed, whose turns cap there, and counts only lines with words", async () => {
    const lines = (n: number): string => Array.from({ length: n }, (_, i) => `${i % 2 === 0 ? "Ava" : "Leo"}: line ${i}.`).join("\n");
    expect(await refused("wavespeed", { prompt: lines(101), params: { speakers: PAIR } })).toEqual({ reason: expect.stringContaining("100") });
    expect(await refused("wavespeed", { prompt: `${lines(100)}\n\n  \n`, params: { speakers: PAIR } })).toBeUndefined();
    expect(await refused("wavespeed", { prompt: lines(101) })).toBeUndefined();
  });
});

describe("retired models", () => {
  it("are exactly the bound models outside the catalog", () => {
    const names = new Set(catalog().models.map((m) => m.name));
    expect(Object.keys(config.media.models).filter((m) => !names.has(m)).sort()).toEqual([...RETIRED].sort());
  });

  it("keep Gemini 3.1 bound on all three upstreams, so a run opened on it finishes there", () => {
    expect(provider.config.models["gemini-3.1-flash-text-to-speech"]!.map((b) => b.upstream)).toEqual(["wavespeed", "fal", "sandbase"]);
  });
});
