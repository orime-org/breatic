// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createProvider } from "../../provider.js";
import { planRoute, type Candidate } from "../../routing/route.js";
import { rejectedInput, estimateCost, orderByPrice, type EstimateInput } from "../estimate.js";

const pricing = (base: number): Record<string, unknown> => ({ kind: "formula", base_price: base, formula: "", discount_rate: 100 });

/**
 * A provider whose one model is bound to WaveSpeed, fal and SandBase; fal takes only 5 and 10 for duration and
 * maps two voices, SandBase drops web search unless it is off.
 * @param prices - Each upstream's flat price, in millionths of a dollar: WaveSpeed, fal, SandBase.
 * @param configured - Which upstreams have a key.
 * @returns The provider.
 */
function bound(prices: readonly number[] = [300, 100, 200], configured: readonly boolean[] = [true, true, true]): ReturnType<typeof createProvider> {
  const names = ["wavespeed", "fal", "sandbase"];
  return createProvider({
    config: {
      upstreams: {
        wavespeed: { kind: "wavespeed", base_url: "https://w.example", key_env: "WAVESPEED_API_KEY" },
        fal: { kind: "fal", base_url: "https://f.example", key_env: "FAL_KEY" },
        sandbase: { kind: "sandbase", base_url: "https://s.example", key_env: "SANDBASE_API_KEY" },
      },
      media: {
        models: {
          m: {
            upstreams: [
              { upstream: "wavespeed", weight: 1, model_id: "m", params: { duration: { field: "duration" }, voice_id: { field: "voice" }, web: { field: "web" } }, pricing: pricing(prices[0]!) },
              {
                upstream: "fal",
                weight: 2,
                model_id: "m",
                output_field: "audio",
                params: { duration: { field: "duration", supported: [5, 10] }, voice_id: { field: "voice" }, web: { field: "web" } },
                voice_map: { voice_id: { Alicia: "alicia", Adam: "adam" } },
                pricing: pricing(prices[1]!),
              },
              { upstream: "sandbase", weight: 3, model_id: "m", params: { duration: { field: "duration" }, voice_id: { field: "voice" } }, drops: { web: [false] }, pricing: pricing(prices[2]!) },
            ],
          },
        },
      },
    },
    keyOf: (env) => (configured[names.findIndex((n) => env.startsWith(n.toUpperCase()))] ? "k" : undefined),
    llmMaxRetries: 0,
    cleanText: (t) => t,
  });
}

/**
 * An estimate input with these params.
 * @param params - Our params.
 * @returns The input.
 */
const run = (params: Record<string, unknown>): EstimateInput => ({ params, prompt: "hi", durations: {}, placeholders: [], durationsMissing: [] });

/**
 * What one upstream refuses of a run's params.
 * @param p - The provider.
 * @param upstream - The upstream.
 * @param params - Our params.
 * @returns The refused param and value, if any.
 */
const refused = (p: ReturnType<typeof createProvider>, upstream: string, params: Record<string, unknown>) => rejectedInput(p.pricingRules("m"), upstream, params);

describe("rejectedInput", () => {
  it("takes a run that leaves a limited param out or empty", () => {
    const p = bound();
    expect(refused(p, "fal", {})).toBeUndefined();
    expect(refused(p, "fal", { duration: null, voice_id: "" })).toBeUndefined();
  });

  it("names the param and value a supported list refuses", () => {
    const p = bound();
    expect(refused(p, "fal", { duration: 10 })).toBeUndefined();
    expect(refused(p, "fal", { duration: 15 })).toEqual({ param: "duration", value: 15 });
  });

  it("names a voice the voice map does not have", () => {
    const p = bound();
    expect(refused(p, "fal", { voice_id: "Alicia" })).toBeUndefined();
    expect(refused(p, "fal", { voice_id: "Warren" })).toEqual({ param: "voice_id", value: "Warren" });
  });

  it("takes a dropped param only at the listed values", () => {
    const p = bound();
    expect(refused(p, "sandbase", { web: false })).toBeUndefined();
    expect(refused(p, "sandbase", { web: true })).toEqual({ param: "web", value: true });
  });

  it("takes anything on an upstream with no limits", () => {
    expect(refused(bound(), "wavespeed", { duration: 15, voice_id: "Warren", web: true })).toBeUndefined();
  });
});

describe("estimates skip an upstream that cannot take the run", () => {
  it("orders only the upstreams that take the run", async () => {
    const p = bound();
    const order = await orderByPrice(p.pricingRules("m"), p.availability("m"), run({ duration: 15, web: true }));
    expect(order.map((e) => e.upstream)).toEqual(["wavespeed"]);
  });

  it("estimates default on the first configured upstream that takes the run", async () => {
    const p = bound([300, 100, 200], [false, true, true]);
    expect((await estimateCost(p.pricingRules("m"), p.availability("m"), run({ duration: 15 }), { mode: "default" }))?.upstream).toBe("sandbase");
  });

  it("estimates nothing for a named upstream that cannot take the run", async () => {
    const p = bound();
    expect(await estimateCost(p.pricingRules("m"), p.availability("m"), run({ duration: 15 }), { mode: "upstream", upstream: "fal" })).toBeNull();
  });

  it("property: the estimate's upstream is the first one the route would try", async () => {
    const valueArb = fc.record({ duration: fc.constantFrom(5, 10, 15, null), voice_id: fc.constantFrom("Alicia", "Warren", null), web: fc.constantFrom(true, false, null) });
    const flags = fc.array(fc.boolean(), { minLength: 3, maxLength: 3 });
    const prices = fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 3, maxLength: 3 });
    await fc.assert(fc.asyncProperty(valueArb, flags, prices, fc.constantFrom("default", "cheapest"), async (params, configured, cost, mode) => {
      const p = bound(cost, configured);
      const rules = p.pricingRules("m");
      const estimate = await estimateCost(rules, p.availability("m"), run(params), { mode });
      const order = await orderByPrice(rules, p.availability("m"), run(params));
      const candidates: Candidate[] = p.availability("m").upstreams.map((u) => ({
        ...u,
        estimateUsd: order.find((e) => e.upstream === u.upstream)?.usd,
        unsupported: rejectedInput(rules, u.upstream, params),
      }));
      let first: string | undefined;
      try {
        first = planRoute("m", { mode }, candidates).order[0]?.upstream;
      } catch {
        first = undefined;
      }
      expect(estimate?.upstream).toBe(first);
    }));
  });
});

describe("planRoute with input limits", () => {
  const wavespeed: Candidate = { upstream: "wavespeed", weight: 1, configured: true, envVar: "WAVESPEED_API_KEY" };
  const fal: Candidate = { upstream: "fal", weight: 2, configured: true, envVar: "FAL_KEY", unsupported: { param: "duration", value: 15 } };

  it("skips an upstream that cannot take the run and says which param and value", () => {
    const plan = planRoute("m", { mode: "default" }, [fal, wavespeed]);
    expect(plan.order.map((c) => c.upstream)).toEqual(["wavespeed"]);
    expect(plan.skipped).toEqual([{ upstream: "fal", kind: "unsupported_input", param: "duration", value: 15 }]);
  });

  it("refuses a named upstream that cannot take the run with the same reason", () => {
    expect(() => planRoute("m", { mode: "upstream", upstream: "fal" }, [fal, wavespeed])).toThrow(
      expect.objectContaining({ reasons: [{ upstream: "fal", kind: "unsupported_input", param: "duration", value: 15 }] }),
    );
  });
});
