// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import type { MediaBinding } from "../../config/schema.js";
import { createProvider } from "../../provider.js";
import { estimateCost, orderByPrice, type EstimateInput } from "../estimate.js";

const flat = (base: number): MediaBinding["pricing"] => ({ kind: "formula", base_price: base, formula: "", discount_rate: 100 });
const VOCAL = "https://cdn.example/vocal.mp3";
const VOICE = "https://cdn.example/voice.mp3";
const IMG_1 = "https://cdn.example/1.png";
const IMG_2 = "https://cdn.example/2.png";
const SOURCE_KEYS = { [VOCAL]: "sha-vocal", [VOICE]: "sha-voice", [IMG_1]: "sha-1", [IMG_2]: "sha-2" };

/**
 * A provider with three models on two WaveSpeed-kind upstreams: a voice clone whose own call is the clone
 * (ws_a $1.60, ws_b $1.52, then $0.01 of speech), a song whose vocal step clones (ws_a $7.50 + $0.225,
 * ws_b $5.00 + $0.15), and a video whose element step clones each image ($0.01 each, $1.00 for the video).
 * @returns The provider.
 */
function provider(): ReturnType<typeof createProvider> {
  const voice = (upstream: string, weight: number, price: number): MediaBinding => ({
    upstream,
    weight,
    model_id: "minimax/voice-clone",
    params: { audio: { field: "audio" } },
    reused_by: "audio",
    extra_steps: [{ kind: "speak", endpoint: "minimax/speech-2.8-hd", at: "after", pricing: flat(10_000) }],
    pricing: flat(price),
  });
  const song = (upstream: string, weight: number, clone: number, own: number): MediaBinding => ({
    upstream,
    weight,
    model_id: "mureka-ai/mureka-v9.5/generate-song",
    prompt_field: "prompt",
    params: { lyrics: { field: "lyrics" }, vocal: { field: "vocal_id" } },
    extra_steps: [{ kind: "vocal", endpoint: "mureka-ai/vocal-clone", at: "before", for_param: "vocal", pricing: flat(clone) }],
    pricing: flat(own),
  });
  return createProvider({
    config: {
      upstreams: {
        ws_a: { kind: "wavespeed", base_url: "https://a.example", key_env: "WS_A_KEY" },
        ws_b: { kind: "wavespeed", base_url: "https://b.example", key_env: "WS_B_KEY" },
        openrouter: { kind: "openrouter", base_url: "https://o.example", key_env: "OPENROUTER_API_KEY" },
      },
      llm: {
        routes: [{ prefix: "", upstreams: [{ upstream: "openrouter", weight: 0 }] }],
        understand_routes: [{ prefix: "", upstreams: [{ upstream: "openrouter", weight: 0 }] }],
      },
      media: {
        models: {
          voice: { upstreams: [voice("ws_a", 1, 1_600_000), voice("ws_b", 2, 1_520_000)] },
          song: { upstreams: [song("ws_a", 1, 7_500_000, 225_000), song("ws_b", 2, 5_000_000, 150_000)] },
          elements: {
            upstreams: [{
              upstream: "ws_a",
              weight: 1,
              model_id: "kwaivgi/kling-video",
              prompt_field: "prompt",
              params: { elements: { field: "elements" } },
              mentions: { elements: "Element {n}" },
              extra_steps: [{
                kind: "element",
                endpoint: "kwaivgi/kling-elements",
                at: "before",
                for_param: "elements",
                per_item: true,
                describe: { model: "google/gemini-test", question: "Describe this image in one sentence.", max_output_tokens: 200 },
                pricing: flat(10_000),
              }],
              pricing: flat(1_000_000),
            }],
          },
        },
      },
    },
    keyOf: () => "k",
    llmMaxRetries: 0,
    cleanText: (t) => t,
  });
}

/**
 * An estimate input for these params, with the clones the caller's cache holds.
 * @param params - Our params.
 * @param clones - The live clones; undefined when the caller does not know them (the browser).
 * @returns The input.
 */
const run = (params: Record<string, unknown>, clones?: NonNullable<EstimateInput["known"]>["clones"]): EstimateInput => ({
  params,
  prompt: "a song",
  durations: {},
  placeholders: [],
  durationsMissing: [],
  ...(clones === undefined ? {} : { known: { sourceKeys: SOURCE_KEYS, clones } }),
});

const p = provider();
const cheapest = async (model: string, input: EstimateInput): Promise<unknown> => estimateCost(p.pricingRules(model), p.availability(model), input, { mode: "cheapest" });

describe("estimates with the caller's live clones", () => {
  it("leaves out a voice clone the upstream holds, and is exact", async () => {
    const held = [{ upstream: "ws_a", kind: "voice" as const, sourceKey: "sha-voice", upstreamId: "BreaticOld" }];
    expect(await cheapest("voice", run({ audio: VOICE }, held))).toEqual({ usd: 0.01, bound: "exact", upstream: "ws_a" });
  });

  it("prices the clone, exactly, when the caller knows no upstream holds it", async () => {
    expect(await cheapest("voice", run({ audio: VOICE }, []))).toEqual({ usd: 1.53, bound: "exact", upstream: "ws_b" });
  });

  it("stays an upper bound when the caller does not know its clones", async () => {
    expect(await cheapest("voice", run({ audio: VOICE }))).toEqual({ usd: 1.53, bound: "at_most", upstream: "ws_b" });
  });

  it("stays an upper bound for a vocal clone when the caller does not know its clones", async () => {
    expect(await cheapest("song", run({ lyrics: "la", vocal: VOCAL }))).toEqual({ usd: 5.15, bound: "at_most", upstream: "ws_b" });
  });

  it("leaves out a vocal clone the upstream holds", async () => {
    const held = [{ upstream: "ws_a", kind: "vocal" as const, sourceKey: "sha-vocal", upstreamId: "163346152292353" }];
    expect(await cheapest("song", run({ lyrics: "la", vocal: VOCAL }, held))).toEqual({ usd: 0.225, bound: "exact", upstream: "ws_a" });
  });

  it("does not take a voice clone of the same recording for a vocal clone", async () => {
    const held = [{ upstream: "ws_a", kind: "voice" as const, sourceKey: "sha-vocal", upstreamId: "BreaticVoice" }];
    expect(await cheapest("song", run({ lyrics: "la", vocal: VOCAL }, held))).toEqual({ usd: 5.15, bound: "exact", upstream: "ws_b" });
  });

  it("counts a clone only on the upstream that holds it", async () => {
    const held = [{ upstream: "ws_b", kind: "vocal" as const, sourceKey: "sha-vocal", upstreamId: "v-b" }];
    const order = await orderByPrice(p.pricingRules("song"), p.availability("song"), run({ lyrics: "la", vocal: VOCAL }, held));
    expect(order.map((e) => [e.upstream, e.usd, e.bound])).toEqual([["ws_b", 0.15, "exact"], ["ws_a", 7.725, "exact"]]);
  });

  it("prices a source with no key as a clone the run makes", async () => {
    const held = [{ upstream: "ws_a", kind: "vocal" as const, sourceKey: "sha-vocal", upstreamId: "v-a" }];
    const unknown = "https://elsewhere.example/v.mp3";
    expect(await cheapest("song", run({ lyrics: "la", vocal: unknown }, held))).toEqual({ usd: 5.15, bound: "exact", upstream: "ws_b" });
  });

  it("leaves out each held element of a per-item step, keyed by its place in the list", async () => {
    const first = [{ upstream: "ws_a", kind: "element" as const, sourceKey: "sha-1:Element 1", upstreamId: "el-1" }];
    expect(await cheapest("elements", run({ elements: [IMG_1, IMG_2] }, first))).toEqual({ usd: 1.01, bound: "exact", upstream: "ws_a" });
    const moved = [{ upstream: "ws_a", kind: "element" as const, sourceKey: "sha-1:Element 2", upstreamId: "el-1" }];
    expect(await cheapest("elements", run({ elements: [IMG_1, IMG_2] }, moved))).toEqual({ usd: 1.02, bound: "exact", upstream: "ws_a" });
    const both = [...first, { upstream: "ws_a", kind: "element" as const, sourceKey: "sha-2:Element 2", upstreamId: "el-2" }];
    expect(await cheapest("elements", run({ elements: [IMG_1, IMG_2] }, both))).toEqual({ usd: 1, bound: "exact", upstream: "ws_a" });
  });
});
