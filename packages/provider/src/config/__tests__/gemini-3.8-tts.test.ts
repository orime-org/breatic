// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Gemini 3.8 Flash TTS replaces 3.1 (#1521): bound to WaveSpeed (fal and SandBase follow once they are enabled), a
 * dialogue sent as turns.
 */

import { describe, expect, it } from "vitest";
import { buildBody } from "../../media/body.js";
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
  it("is bound to WaveSpeed", () => {
    expect(provider.config.models[MODEL]!.map((b) => [b.upstream, b.weight, b.model_id])).toEqual([
      ["wavespeed", 1, "google/gemini-3.8-flash/text-to-speech"],
    ]);
  });

  it("is in the catalog with no language param", () => {
    const entry = catalog().models.find((m) => m.name === MODEL);
    expect(entry).toBeDefined();
    expect(entry!.params.language).toBeUndefined();
  });

  it("reads a line holding only a speaker's name as a turn of nobody's, and sends no turn for it (#1521)", async () => {
    expect(buildBody(bindingOn("wavespeed"), { prompt: "Ava: Hi.\nLeo:\nAva: Bye.", params: { speakers: PAIR } })).toMatchObject({
      turns: [{ speaker_id: "Ava", text: "Hi." }, { speaker_id: "Ava", text: "Bye." }],
    });
    // A hundred lines that say something and one that says nothing is a hundred turns, within WaveSpeed's cap.
    const hundred = Array.from({ length: 100 }, (_, i) => `${i % 2 === 0 ? "Ava" : "Leo"}: line ${i}.`).join("\n");
    expect(await refused("wavespeed", { prompt: `${hundred}\nLeo:`, params: { speakers: PAIR } })).toBeUndefined();
  });

  it("sends a dialogue to WaveSpeed as speakers and turns, with no text", () => {
    expect(buildBody(bindingOn("wavespeed"), { prompt: "Ava: Hi.\nLeo: Hello.", params: { speakers: PAIR, voice_id: "Kore" } })).toEqual({
      speakers: [{ speaker_id: "Ava", voice: "Kore" }, { speaker_id: "Leo", voice: "Puck" }],
      turns: [{ speaker_id: "Ava", text: "Hi." }, { speaker_id: "Leo", text: "Hello." }],
      voice: "Kore",
    });
  });

  it("sends a single voice to WaveSpeed as its text and voice", () => {
    expect(buildBody(bindingOn("wavespeed"), { prompt: "Hi.", params: { voice_id: "Kore" } })).toEqual({ text: "Hi.", voice: "Kore" });
  });

  it("takes any named speaker on WaveSpeed, whose 3.8 endpoint asks only for a non-empty id", async () => {
    expect(await refused("wavespeed", { prompt: "Al ice: Hi.", params: { speakers: [{ speaker: "Al ice", voice: "Kore" }, { speaker: "李·明", voice: "Puck" }] } })).toBeUndefined();
  });

  it("keeps a single-voice script over 8000 characters off WaveSpeed, whose text field caps there", async () => {
    expect(await refused("wavespeed", { prompt: "x".repeat(8001) })).toEqual({ reason: "WaveSpeed text maxLength 8000", limit: { field: "prompt", measure: "characters", max: 8000 } });
    expect(await refused("wavespeed", { prompt: "x".repeat(8000) })).toBeUndefined();
  });

  it("holds the text cap to a run that names no speaker, which goes as text whatever its speakers list holds", async () => {
    const unnamed = [{ speaker: "", voice: "Kore" }, { speaker: "", voice: "Puck" }];
    expect(buildBody(bindingOn("wavespeed"), { prompt: "x".repeat(10), params: { speakers: unnamed, voice_id: "Kore" } })).toHaveProperty("text");
    expect(await refused("wavespeed", { prompt: "x".repeat(8001), params: { speakers: unnamed } })).toMatchObject({ limit: { field: "prompt", measure: "characters", max: 8000 } });
  });

  it("takes a dialogue longer than 8000 characters in all, and keeps one with a line over 8000 off WaveSpeed", async () => {
    const long = `Ava: ${"x".repeat(5000)}\nLeo: ${"y".repeat(5000)}`;
    expect(await refused("wavespeed", { prompt: long, params: { speakers: PAIR } })).toBeUndefined();
    expect(await refused("wavespeed", { prompt: `Ava: ${"x".repeat(8001)}`, params: { speakers: PAIR } })).toEqual({ reason: "WaveSpeed turns[].text maxLength 8000", limit: { field: "prompt", measure: "characters", max: 8000, per: "line" } });
  });

  it("counts a line's words as the turn WaveSpeed is sent holds them, after the speaker's name", async () => {
    expect(await refused("wavespeed", { prompt: `Ava: ${"x".repeat(8000)}`, params: { speakers: PAIR } })).toBeUndefined();
    expect(await refused("wavespeed", { prompt: `Leo: ${"x".repeat(8000)}`, params: { speakers: [PAIR[0], { speaker: "Leo ", voice: "Puck" }] } })).toBeUndefined();
    // A line naming no speaker goes to the first one whole, so all of it counts.
    expect(await refused("wavespeed", { prompt: `Someone: ${"x".repeat(7992)}`, params: { speakers: PAIR } })).toMatchObject({ limit: { per: "line" } });
  });

  it("keeps a dialogue of more than 100 lines off WaveSpeed, whose turns cap there, and counts only lines with words", async () => {
    const lines = (n: number): string => Array.from({ length: n }, (_, i) => `${i % 2 === 0 ? "Ava" : "Leo"}: line ${i}.`).join("\n");
    expect(await refused("wavespeed", { prompt: lines(101), params: { speakers: PAIR } })).toEqual({ reason: expect.stringContaining("100"), limit: { field: "prompt", measure: "lines", max: 100 } });
    expect(await refused("wavespeed", { prompt: `${lines(100)}\n\n  \n`, params: { speakers: PAIR } })).toBeUndefined();
    expect(await refused("wavespeed", { prompt: lines(101) })).toBeUndefined();
  });
});
