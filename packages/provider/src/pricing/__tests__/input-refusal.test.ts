// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * #1521: a run no configured upstream on its route can take is refused with the limit it broke, so the application
 * can say which one before anything is held.
 */

import { describe, expect, it } from "vitest";
import { createProvider } from "../../provider.js";
import { parseProviderConfig } from "../../config/schema.js";
import { inputRefusal, type EstimateInput } from "../estimate.js";

const pricing = { kind: "formula", base_price: 100, formula: '{"total_price": base_price}', discount_rate: 100 };

/**
 * A provider whose one model is on WaveSpeed (text up to 10 characters) and fal (up to 20), each with a stated limit,
 * and a vendor limit of 30.
 * @param configured - Which of WaveSpeed and fal have a key.
 * @returns The provider.
 */
function bound(configured: readonly [boolean, boolean] = [true, true]): ReturnType<typeof createProvider> {
  return createProvider({
    config: {
      upstreams: {
        wavespeed: { kind: "wavespeed", base_url: "https://w.example", key_env: "WAVESPEED_API_KEY" },
        fal: { kind: "fal", base_url: "https://f.example", billing_url: "https://f.example/v1", key_env: "FAL_KEY" },
      },
      media: {
        models: {
          m: {
            rejects: [{ when: "$length(prompt) > 30", reason: "vendor prompt maxLength 30", source: "https://vendor.example", limit: { field: "prompt", measure: "characters", max: 30 } }],
            upstreams: [
              {
                upstream: "wavespeed", weight: 1, model_id: "m", prompt_field: "text", pricing,
                rejects: [{ when: "$length(text) > 10", reason: "WaveSpeed text maxLength 10", limit: { field: "prompt", measure: "characters", max: 10 } }],
              },
              {
                upstream: "fal", weight: 2, model_id: "m", output_field: "audio", prompt_field: "prompt", pricing,
                rejects: [{ when: "$length(prompt) > 20", reason: "fal prompt maxLength 20" }],
              },
            ],
          },
        },
      },
    },
    keyOf: (env) => ((env === "WAVESPEED_API_KEY" ? configured[0] : configured[1]) ? "k" : undefined),
    llmMaxRetries: 0,
    cleanText: (t) => t,
  });
}

/**
 * A run of this prompt.
 * @param prompt - The prompt.
 * @returns The input.
 */
const run = (prompt: string): EstimateInput => ({ params: {}, prompt, durations: {}, placeholders: [], durationsMissing: [] });

/**
 * What the route refuses a prompt for.
 * @param p - The provider.
 * @param prompt - The prompt.
 * @param route - The route.
 * @returns The refusal, or null.
 */
const refusal = (p: ReturnType<typeof createProvider>, prompt: string, route: Parameters<typeof inputRefusal>[3] = { mode: "default" }) =>
  inputRefusal(p.pricingRules("m"), p.availability("m"), run(prompt), route);

describe("inputRefusal", () => {
  it("refuses nothing while some configured upstream on the route takes the run", async () => {
    expect(await refusal(bound(), "x".repeat(15))).toBeNull();
    expect(await refusal(bound(), "x".repeat(5))).toBeNull();
  });

  it("gives the first upstream's refusal, with its limit, when none takes the run", async () => {
    expect(await refusal(bound(), "x".repeat(25))).toEqual({
      reason: "WaveSpeed text maxLength 10",
      limit: { field: "prompt", measure: "characters", max: 10 },
    });
  });

  it("reads the model vendor's limit first, as routing does", async () => {
    expect(await refusal(bound(), "x".repeat(31))).toEqual({
      reason: "vendor prompt maxLength 30",
      limit: { field: "prompt", measure: "characters", max: 30 },
    });
  });

  it("reads only the upstreams with a key, in weight order", async () => {
    expect(await refusal(bound([false, true]), "x".repeat(15))).toBeNull();
    expect(await refusal(bound([false, true]), "x".repeat(25))).toEqual({ reason: "fal prompt maxLength 20" });
  });

  it("reads only the upstream a route names", async () => {
    expect(await refusal(bound(), "x".repeat(15), { mode: "upstream", upstream: "wavespeed" })).toMatchObject({ limit: { max: 10 } });
    expect(await refusal(bound(), "x".repeat(15), { mode: "upstream", upstream: "fal" })).toBeNull();
  });

  it("reads every configured upstream on the cheapest route", async () => {
    expect(await refusal(bound(), "x".repeat(15), { mode: "cheapest" })).toBeNull();
    expect(await refusal(bound(), "x".repeat(25), { mode: "cheapest" })).toMatchObject({ limit: { max: 10 } });
  });

  it("refuses nothing when no upstream has a key, which servability answers instead", async () => {
    expect(await refusal(bound([false, false]), "x".repeat(25))).toBeNull();
  });

  it("is what the provider answers for a model", async () => {
    const p = bound();
    expect(await p.refusal("m", run("x".repeat(25)), { mode: "default" })).toMatchObject({ limit: { max: 10 } });
    expect(await p.refusal("m", run("x"), { mode: "default" })).toBeNull();
  });
});

describe("a reject's limit", () => {
  const config = (limit: unknown) => ({
    upstreams: { wavespeed: { kind: "wavespeed", base_url: "https://w.example", key_env: "WAVESPEED_API_KEY" } },
    media: { models: { m: { upstreams: [{ upstream: "wavespeed", weight: 1, model_id: "m", pricing, rejects: [{ when: "true", reason: "r", limit }] }] } } },
  });

  it("takes a count of characters or lines, at most or at least, of a field, whole or per line or item", () => {
    for (const limit of [
      { field: "prompt", measure: "characters", max: 1 },
      { field: "prompt", measure: "characters", min: 3 },
      { field: "prompt", measure: "characters", max: 8000, per: "line" },
      { field: "prompt", measure: "lines", max: 100 },
      { field: "multi_prompt", measure: "characters", max: 512, per: "item" },
    ]) {
      expect(() => parseProviderConfig(config(limit) as never)).not.toThrow();
    }
  });

  it("refuses a limit with neither or both bounds, an unknown measure or an unknown key", () => {
    for (const limit of [
      { field: "prompt", measure: "characters" },
      { field: "prompt", measure: "characters", max: 1, min: 1 },
      { field: "prompt", measure: "words", max: 1 },
      { field: "prompt", measure: "characters", max: 1, unit: "x" },
    ]) {
      expect(() => parseProviderConfig(config(limit) as never)).toThrow();
    }
  });
});
