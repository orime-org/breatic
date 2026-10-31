// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createProvider } from "../../provider.js";
import { estimateCost, orderByPrice, parsePricingRules, type EstimateInput } from "../estimate.js";

const input: EstimateInput = { params: {}, prompt: "a fox", durations: {}, placeholders: [], durationsMissing: [] };
const NAMES = ["up_a", "up_b", "up_c"] as const;

/**
 * A provider whose one model is bound to three upstreams at flat prices.
 * @param prices - Each upstream's price, in millionths of a dollar.
 * @param configured - Which upstreams have a key.
 * @returns The provider.
 */
function priced(prices: readonly number[], configured: readonly boolean[] = [true, true, true]): ReturnType<typeof createProvider> {
  return createProvider({
    config: {
      upstreams: Object.fromEntries(NAMES.map((n) => [n, { kind: "wavespeed", base_url: "https://x.example", key_env: `${n.toUpperCase()}_KEY` }])),
      media: {
        models: {
          m: {
            upstreams: NAMES.map((upstream, i) => ({
              upstream,
              weight: i + 1,
              model_id: "m",
              pricing: { kind: "formula", base_price: prices[i]!, formula: "", discount_rate: 100 },
            })),
          },
        },
      },
    },
    keyOf: (name) => (configured[NAMES.findIndex((n) => `${n.toUpperCase()}_KEY` === name)] ? "k" : undefined),
    llmMaxRetries: 0,
    cleanText: (t) => t,
  });
}

const pricesArb = fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 3, maxLength: 3 });
const configuredArb = fc.array(fc.boolean(), { minLength: 3, maxLength: 3 });

describe("orderByPrice and estimateCost", () => {
  it("property: the order is by estimate, equal estimates by weight, and no estimate is negative", async () => {
    await fc.assert(fc.asyncProperty(pricesArb, configuredArb, async (prices, configured) => {
      const p = priced(prices, configured);
      const order = await orderByPrice(p.pricingRules("m"), p.availability("m"), input);
      expect(order.map((e) => e.upstream).sort()).toEqual(NAMES.filter((_, i) => configured[i]).slice().sort());
      for (let i = 1; i < order.length; i++) {
        const [a, b] = [order[i - 1]!, order[i]!];
        expect(a.usd < b.usd || (a.usd === b.usd && a.weight < b.weight)).toBe(true);
      }
      for (const e of order) expect(e.usd).toBeGreaterThanOrEqual(0);
    }));
  });

  it("property: cheapest is the head of the order, default the configured one of smallest weight", async () => {
    await fc.assert(fc.asyncProperty(pricesArb, configuredArb, async (prices, configured) => {
      const p = priced(prices, configured);
      const order = await orderByPrice(p.pricingRules("m"), p.availability("m"), input);
      const cheapest = await estimateCost(p.pricingRules("m"), p.availability("m"), input, { mode: "cheapest" });
      const byWeight = await estimateCost(p.pricingRules("m"), p.availability("m"), input, { mode: "default" });
      if (order.length === 0) {
        expect(cheapest).toBeNull();
        expect(byWeight).toBeNull();
        return;
      }
      expect(cheapest?.upstream).toBe(order[0]!.upstream);
      expect(byWeight?.upstream).toBe(NAMES.find((_, i) => configured[i]));
    }));
  });

  it("property: the browser's estimate equals the server's for every route", async () => {
    await fc.assert(fc.asyncProperty(pricesArb, configuredArb, fc.constantFrom(...NAMES), async (prices, configured, named) => {
      const p = priced(prices, configured);
      for (const route of [{ mode: "default" as const }, { mode: "cheapest" as const }, { mode: "upstream" as const, upstream: named }]) {
        const rules = parsePricingRules(JSON.parse(JSON.stringify(p.pricingRules("m"))) as unknown);
        expect(await estimateCost(rules, p.availability("m"), input, route)).toEqual(await p.estimate("m", input, route));
      }
    }));
  });

  it("answers the named upstream's estimate in upstream mode, and null when that one has no key", async () => {
    const p = priced([300_000, 100_000, 200_000], [true, false, true]);
    expect(await estimateCost(p.pricingRules("m"), p.availability("m"), input, { mode: "upstream", upstream: "up_c" })).toMatchObject({ upstream: "up_c", usd: 0.2 });
    expect(await estimateCost(p.pricingRules("m"), p.availability("m"), input, { mode: "upstream", upstream: "up_b" })).toBeNull();
  });

  it("accepts rules that came over the wire and refuses anything else", () => {
    const wire = JSON.parse(JSON.stringify(priced([1, 2, 3]).pricingRules("m"))) as unknown;
    expect(parsePricingRules(wire).model).toBe("m");
    expect(() => parsePricingRules({ nope: true })).toThrow();
  });

  it.each([
    ["for_param", { for_param: 7 }],
    ["per_item", { per_item: "yes" }],
    ["reused", { reused: "true" }],
  ])("refuses a step whose %s is of the wrong type, which estimateCost would misread", (_field, step) => {
    const wire = JSON.parse(JSON.stringify(priced([1, 2, 3]).pricingRules("m"))) as { upstreams: { steps: unknown[] }[] };
    wire.upstreams[0]!.steps = [{ ...step }];
    expect(() => parsePricingRules(wire)).toThrow();
  });
});
