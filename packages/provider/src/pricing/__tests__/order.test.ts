// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createProvider } from "../../provider.js";
import type { MediaBinding } from "../../config/schema.js";
import { estimateCost, orderByPrice, parsePricingRules, type EstimateInput } from "../estimate.js";
import { clipArb, overVendorLimit, vendorAudioLimit, vendorMaxArb } from "./vendor-limit.js";

const input: EstimateInput = { params: {}, prompt: "a fox", durations: {}, placeholders: [], durationsMissing: [] };
const NAMES = ["up_a", "up_b", "up_c"] as const;

/**
 * A provider whose one model is bound to three upstreams at flat prices.
 * @param prices - Each upstream's price, in millionths of a dollar.
 * @param configured - Which upstreams have a key.
 * @param vendorMax - The longest audio clip the model's vendor takes, as the model's own reject; null for none.
 * @returns The provider.
 */
function priced(prices: readonly number[], configured: readonly boolean[] = [true, true, true], vendorMax: number | null = null): ReturnType<typeof createProvider> {
  return createProvider({
    config: {
      upstreams: Object.fromEntries(NAMES.map((n) => [n, { kind: "wavespeed", base_url: "https://x.example", key_env: `${n.toUpperCase()}_KEY` }])),
      media: {
        models: {
          m: {
            ...vendorAudioLimit(vendorMax),
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

  it("property: the browser's estimate equals the server's for every route, the model vendor's limits included", async () => {
    await fc.assert(fc.asyncProperty(pricesArb, configuredArb, fc.constantFrom(...NAMES), vendorMaxArb, clipArb, async (prices, configured, named, vendorMax, clip) => {
      const p = priced(prices, configured, vendorMax);
      const run: EstimateInput = clip === null ? input : { ...input, params: { audio: "https://a/a.mp3" }, durations: { audio: [clip] } };
      for (const route of [{ mode: "default" as const }, { mode: "cheapest" as const }, { mode: "upstream" as const, upstream: named }]) {
        const rules = parsePricingRules(JSON.parse(JSON.stringify(p.pricingRules("m"))) as unknown);
        const server = await p.estimate("m", run, route);
        expect(await estimateCost(rules, p.availability("m"), run, route)).toEqual(server);
        if (overVendorLimit(vendorMax, clip)) expect(server).toBeNull();
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
    expect(() => parsePricingRules({ nope: true })).toThrow("Not a model's pricing rules");
  });

  it.each([
    ["for_param", { for_param: 7 }],
    ["per_item", { per_item: "yes" }],
    ["kind", { kind: 7 }],
  ])("refuses a step whose %s is of the wrong type, which estimateCost would misread", (_field, step) => {
    const wire = JSON.parse(JSON.stringify(priced([1, 2, 3]).pricingRules("m"))) as { upstreams: { steps: unknown[] }[] };
    wire.upstreams[0]!.steps = [{ ...step }];
    expect(() => parsePricingRules(wire)).toThrow();
  });
});

/**
 * A provider whose one model is bound as given, every upstream configured.
 * @param upstreams - The bindings.
 * @returns The provider.
 */
function bound(upstreams: MediaBinding[]): ReturnType<typeof createProvider> {
  return createProvider({
    config: {
      upstreams: Object.fromEntries(upstreams.map((b) => [b.upstream, { kind: "wavespeed", base_url: "https://x.example", key_env: "K" }])),
      media: { models: { m: { upstreams } } },
    },
    keyOf: () => "k",
    llmMaxRetries: 0,
    cleanText: (t) => t,
  });
}

const formula = (base: number, text = ""): MediaBinding["pricing"] => ({ kind: "formula", base_price: base, formula: text, discount_rate: 100 });

describe("the order of estimates at its edges", () => {
  it("keeps equal prices in weight order, whatever order the availability lists them in", async () => {
    const p = priced([5, 5, 5]);
    const reversed = { ...p.availability("m"), upstreams: [...p.availability("m").upstreams].reverse() };
    for (const availability of [p.availability("m"), reversed]) {
      expect((await orderByPrice(p.pricingRules("m"), availability, input)).map((e) => e.upstream)).toEqual(["up_a", "up_b", "up_c"]);
    }
  });

  it("estimates the configured upstream of smallest weight by default, whatever order the availability lists them in", async () => {
    const p = priced([300_000, 100_000, 200_000]);
    const availability = { ...p.availability("m"), upstreams: [...p.availability("m").upstreams].reverse() };
    expect(await estimateCost(p.pricingRules("m"), availability, input, { mode: "default" })).toMatchObject({ upstream: "up_a" });
  });

  it("is exact for a run of a model that clones nothing, though the caller does not know its clones", async () => {
    const p = priced([300_000, 100_000, 200_000]);
    expect(await estimateCost(p.pricingRules("m"), p.availability("m"), input, { mode: "default" })).toMatchObject({ bound: "exact" });
  });

  it("puts a price that is only a lower bound after every known price", async () => {
    const p = bound([
      { upstream: "up_a", weight: 1, model_id: "m", params: { video: { field: "video" } }, pricing: formula(1, '{"total_price": get_duration(video) * base_price}') },
      { upstream: "up_b", weight: 2, model_id: "m", params: { video: { field: "video" } }, pricing: formula(300_000) },
    ]);
    const run = { ...input, params: { video: "https://a/v.mp4" }, durationsMissing: ["video"] };
    expect((await orderByPrice(p.pricingRules("m"), p.availability("m"), run)).map((e) => [e.upstream, e.bound])).toEqual([["up_b", "exact"], ["up_a", "at_least"]]);
  });

  it("is a lower bound when only an extra step's price reads a param still to be filled in", async () => {
    const p = bound([{
      upstream: "up_a",
      weight: 1,
      model_id: "m",
      params: { song: { field: "song" } },
      extra_steps: [{ kind: "upload_reference", endpoint: "u", at: "before", for_param: "song", pricing: formula(1, '{"total_price": $length(song) * base_price}') }],
      pricing: formula(100_000),
    }]);
    const run = { ...input, params: { song: "https://a/s.mp3" }, placeholders: ["song"] };
    expect(await estimateCost(p.pricingRules("m"), p.availability("m"), run, { mode: "default" })).toMatchObject({ bound: "at_least" });
  });

  it("are empty for a model the configuration does not bind", () => {
    expect(priced([1, 2, 3]).pricingRules("unbound")).toEqual({ model: "unbound", upstreams: [] });
  });

  it("carries the values an upstream limits a param to over the wire", () => {
    const p = bound([{ upstream: "up_a", weight: 1, model_id: "m", params: { size: { field: "size", supported: ["1k", 2, true] } }, pricing: formula(1) }]);
    const wire = JSON.parse(JSON.stringify(p.pricingRules("m"))) as unknown;
    expect((parsePricingRules(wire).upstreams[0] as { limits?: unknown } | undefined)?.limits).toEqual({ size: ["1k", 2, true] });
  });
});
