// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createProvider } from "../../provider.js";
import { estimateCost, parsePricingRules, type EstimateInput } from "../estimate.js";

// A step's param asks for the step when it carries something and is not a switch
// turned off: `false` is priced as no step (inner#1692).

const flat = (base_price: number): { kind: "formula"; base_price: number; formula: string; discount_rate: number } => ({ kind: "formula", base_price, formula: "", discount_rate: 100 });

const provider = createProvider({
  config: {
    upstreams: { wavespeed: { kind: "wavespeed", base_url: "https://x.example", key_env: "WAVESPEED_API_KEY" } },
    media: {
      models: {
        m: {
          upstreams: [{
            upstream: "wavespeed",
            weight: 1,
            model_id: "m",
            prompt_field: "prompt",
            pricing: flat(400_000),
            extra_steps: [
              { kind: "upload_reference", endpoint: "x/upload", at: "before", for_param: "song", pricing: flat(50_000) },
              { kind: "element", endpoint: "x/element", at: "before", for_param: "refs", per_item: true, pricing: flat(100_000) },
              { kind: "rig", endpoint: "tripo3d/rig", at: "after", for_param: "rig_skeleton", optional: true, pricing: flat(300_000) },
            ],
          }],
        },
      },
    },
  },
  keyOf: (name) => (name === "WAVESPEED_API_KEY" ? "k" : undefined),
  llmMaxRetries: 0,
  cleanText: (t) => t,
});

const run = (params: Record<string, unknown>): EstimateInput => ({ params, prompt: "a knight", durations: {}, placeholders: [], durationsMissing: [] });

/**
 * The server's and the browser's estimate of one run, which must agree.
 * @param params - The run's params.
 * @returns The server's estimate in USD.
 */
async function priced(params: Record<string, unknown>): Promise<number> {
  const server = await provider.estimate("m", run(params), { mode: "default" });
  const rules = parsePricingRules(JSON.parse(JSON.stringify(provider.pricingRules("m"))) as unknown);
  const browser = await estimateCost(rules, provider.availability("m"), run(params), { mode: "default" });
  expect(browser).toEqual(server);
  // An element is a clone, priced as an upper bound while the caller's clones are not known.
  const clones = Array.isArray(params.refs) && params.refs.length > 0;
  expect(server?.bound).toBe(clones ? "at_most" : "exact");
  return server!.usd;
}

describe("a step is priced only when its param asks for it", () => {
  it.each([
    ["absent", {}, 0.4],
    ["a switch on", { rig_skeleton: true }, 0.7],
    ["a switch off", { rig_skeleton: false }, 0.4],
    ["a url", { song: "https://cdn.example/a.mp3" }, 0.45],
    ["an empty url", { song: "" }, 0.4],
    ["a list of two", { refs: ["https://cdn.example/1.png", "https://cdn.example/2.png"] }, 0.6],
    ["an empty list", { refs: [] }, 0.4],
    ["null", { rig_skeleton: null }, 0.4],
  ])("%s", async (_what, params, usd) => {
    expect(await priced(params)).toBeCloseTo(usd, 9);
  });

  it("property: a switch turned off prices as absent, and list and url steps price as before", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 0, max: 3 }),
      fc.boolean(),
      fc.constantFrom<"absent" | "on" | "off">("absent", "on", "off"),
      async (items, song, rig) => {
        const params: Record<string, unknown> = { refs: Array.from({ length: items }, (_, i) => `https://cdn.example/${i}.png`) };
        if (song) params.song = "https://cdn.example/a.mp3";
        if (rig !== "absent") params.rig_skeleton = rig === "on";
        const expected = 0.4 + 0.1 * items + (song ? 0.05 : 0) + (rig === "on" ? 0.3 : 0);
        expect(await priced(params)).toBeCloseTo(expected, 9);
      },
    ), { numRuns: 40 });
  });
});
