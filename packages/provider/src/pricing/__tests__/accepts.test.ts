// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { NoUpstreamAvailable } from "../../errors.js";
import { createMediaRunner } from "../../media/runner.js";
import { createProvider } from "../../provider.js";
import { planRoute, type Candidate } from "../../routing/route.js";
import { rejectedInput, estimateCost, orderByPrice, parsePricingRules, type EstimateInput } from "../estimate.js";

const pricing = (base: number): Record<string, unknown> => ({ kind: "formula", base_price: base, formula: "", discount_rate: 100 });

/**
 * A provider whose one model is bound to WaveSpeed, fal and SandBase; fal takes only 5 and 10 for duration and
 * maps two voices, SandBase drops web search unless it is off.
 * @param prices - Each upstream's flat price, in millionths of a dollar: WaveSpeed, fal, SandBase.
 * @param configured - Which upstreams have a key.
 * @param vendorMax - The longest audio clip the model's vendor takes, as the model's own reject; null for none.
 * @returns The provider.
 */
function bound(prices: readonly number[] = [300, 100, 200], configured: readonly boolean[] = [true, true, true], vendorMax: number | null = null): ReturnType<typeof createProvider> {
  const names = ["wavespeed", "fal", "sandbase"];
  return createProvider({
    config: {
      upstreams: {
        wavespeed: { kind: "wavespeed", base_url: "https://w.example", key_env: "WAVESPEED_API_KEY" },
        fal: { kind: "fal", base_url: "https://f.example", billing_url: "https://f.example/v1", key_env: "FAL_KEY" },
        sandbase: { kind: "sandbase", base_url: "https://s.example", key_env: "SANDBASE_API_KEY" },
      },
      media: {
        models: {
          m: {
            ...(vendorMax === null ? {} : { rejects: [{ when: `get_duration(audio) > ${vendorMax}`, reason: "vendor audio limit", source: "https://vendor.example/limits" }] }),
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
const refused = (p: ReturnType<typeof createProvider>, upstream: string, params: Record<string, unknown>) => rejectedInput(p.pricingRules("m"), upstream, run(params));

describe("rejectedInput", () => {
  it("takes a run that leaves a limited param out or empty", async () => {
    const p = bound();
    expect(await refused(p, "fal", {})).toBeUndefined();
    expect(await refused(p, "fal", { duration: null, voice_id: "" })).toBeUndefined();
  });

  it("names the param and value a supported list refuses", async () => {
    const p = bound();
    expect(await refused(p, "fal", { duration: 10 })).toBeUndefined();
    expect(await refused(p, "fal", { duration: 15 })).toEqual({ param: "duration", value: 15 });
  });

  it("names a voice the voice map does not have", async () => {
    const p = bound();
    expect(await refused(p, "fal", { voice_id: "Alicia" })).toBeUndefined();
    expect(await refused(p, "fal", { voice_id: "Warren" })).toEqual({ param: "voice_id", value: "Warren" });
  });

  it("takes a dropped param only at the listed values", async () => {
    const p = bound();
    expect(await refused(p, "sandbase", { web: false })).toBeUndefined();
    expect(await refused(p, "sandbase", { web: true })).toEqual({ param: "web", value: true });
  });

  it("takes anything on an upstream with no limits", async () => {
    expect(await refused(bound(), "wavespeed", { duration: 15, voice_id: "Warren", web: true })).toBeUndefined();
  });
});

describe("estimates read only what the upstream is sent", () => {
  it("gives a formula no param the run leaves out or empty", async () => {
    const p = createProvider({
      config: {
        upstreams: { wavespeed: { kind: "wavespeed", base_url: "https://w.example", key_env: "WAVESPEED_API_KEY" } },
        media: {
          models: {
            m: {
              upstreams: [{
                upstream: "wavespeed",
                weight: 1,
                model_id: "m",
                params: { refs: { field: "reference" }, note: { field: "note" } },
                pricing: { kind: "formula", base_price: 100, formula: '{"total_price": base_price + ($count(reference) > 0 ? 50 : 0) + ($exists(note) ? 7 : 0)}', discount_rate: 100 },
              }],
            },
          },
        },
      },
      keyOf: () => "k",
      llmMaxRetries: 0,
      cleanText: (t) => t,
    });
    const usd = async (params: Record<string, unknown>): Promise<number | undefined> => (await estimateCost(p.pricingRules("m"), p.availability("m"), run(params), { mode: "default" }))?.usd;
    expect(await usd({ refs: null, note: "" })).toBeCloseTo(0.0001, 9);
    expect(await usd({ refs: [], note: null })).toBeCloseTo(0.0001, 9);
    expect(await usd({ refs: ["https://a/1.png"], note: "n" })).toBeCloseTo(0.000157, 9);
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

  it("property: the estimate's upstream is the first one the route would try, the model vendor's limits included", async () => {
    const valueArb = fc.record({ duration: fc.constantFrom(5, 10, 15, null), voice_id: fc.constantFrom("Alicia", "Warren", null), web: fc.constantFrom(true, false, null) });
    const flags = fc.array(fc.boolean(), { minLength: 3, maxLength: 3 });
    const prices = fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 3, maxLength: 3 });
    const vendorMaxArb = fc.option(fc.integer({ min: 1, max: 30 }), { nil: null });
    const clipArb = fc.option(fc.integer({ min: 1, max: 40 }), { nil: null });
    await fc.assert(fc.asyncProperty(valueArb, flags, prices, fc.constantFrom("default", "cheapest"), vendorMaxArb, clipArb, async (params, configured, cost, mode, vendorMax, clip) => {
      const p = bound(cost, configured, vendorMax);
      const rules = p.pricingRules("m");
      const input = clip === null ? run(params) : { ...run({ ...params, audio: "https://a/a.mp3" }), durations: { audio: [clip] } };
      const estimate = await estimateCost(rules, p.availability("m"), input, { mode });
      const order = await orderByPrice(rules, p.availability("m"), input);
      const candidates: Candidate[] = await Promise.all(p.availability("m").upstreams.map(async (u) => {
        const priced = order.find((e) => e.upstream === u.upstream);
        return {
          ...u,
          estimate: priced === undefined ? undefined : { usd: priced.usd, atLeast: priced.bound === "at_least" },
          unsupported: await rejectedInput(rules, u.upstream, input),
        };
      }));
      let first: string | undefined;
      try {
        first = planRoute("m", { mode }, candidates).order[0]?.upstream;
      } catch {
        first = undefined;
      }
      expect(estimate?.upstream).toBe(first);
      if (vendorMax !== null && clip !== null && clip > vendorMax) expect(estimate).toBeNull();
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

/**
 * A provider whose one model is bound to WaveSpeed and to fal, fal with input limits of its own:
 * at most 5 characters of prompt, audio up to 9.6 seconds, and a prompt or shots but not both.
 * @param configured - Which of WaveSpeed and fal have a key.
 * @returns The provider.
 */
function limited(configured: readonly boolean[] = [true, true]): ReturnType<typeof createProvider> {
  return createProvider({
    config: {
      upstreams: {
        wavespeed: { kind: "wavespeed", base_url: "https://w.example", key_env: "WAVESPEED_API_KEY" },
        fal: { kind: "fal", base_url: "https://f.example", billing_url: "https://f.example/v1", key_env: "FAL_KEY" },
      },
      media: {
        models: {
          m: {
            upstreams: [
              { upstream: "wavespeed", weight: 1, model_id: "m", prompt_field: "prompt", params: { audio: { field: "audio" }, shots: { field: "multi_prompt" } }, pricing: pricing(300) },
              {
                upstream: "fal",
                weight: 2,
                model_id: "m",
                prompt_field: "text",
                output_field: "video",
                params: { audio: { field: "audio_url" }, shots: { field: "multi_prompt" } },
                rejects: [
                  { when: "$length(text) > 5", reason: "fal text maxLength 5" },
                  { when: "get_duration(audio_url) > 9.6", reason: "fal output stops at 241 frames" },
                  { when: "$exists(text) and $exists(multi_prompt)", reason: "fal takes prompt or multi_prompt, not both" },
                ],
                pricing: pricing(100),
              },
            ],
          },
        },
      },
    },
    keyOf: (env) => (configured[env.startsWith("WAVESPEED") ? 0 : 1] ? "k" : undefined),
    llmMaxRetries: 0,
    cleanText: (t) => t,
  });
}

/**
 * What fal refuses of a run.
 * @param input - The run.
 * @returns What it refuses, if anything.
 */
const onFal = (input: Partial<EstimateInput>) => rejectedInput(limited().pricingRules("m"), "fal", { ...run({}), ...input });

describe("an upstream's own input limits (rejects)", () => {
  it("takes a run within every limit", async () => {
    expect(await onFal({ prompt: "hi", durations: { audio: [5] } })).toBeUndefined();
  });

  it("refuses a prompt over the length, naming the limit", async () => {
    expect(await onFal({ prompt: "a red fox" })).toEqual({ reason: "fal text maxLength 5" });
  });

  it("refuses a source longer than the upstream renders, read from the run's durations", async () => {
    expect(await onFal({ prompt: "hi", params: { audio: "https://a/x.mp3" }, durations: { audio: [12] } })).toEqual({ reason: "fal output stops at 241 frames" });
  });

  it("refuses fields the upstream takes only one of", async () => {
    expect(await onFal({ prompt: "hi", params: { shots: [{ prompt: "a" }] } })).toEqual({ reason: "fal takes prompt or multi_prompt, not both" });
    expect(await onFal({ prompt: "", params: { shots: [{ prompt: "a" }] } })).toBeUndefined();
  });

  it("leaves the refusing upstream out of the price order and the estimate, in the browser too", async () => {
    const p = limited();
    const long = { ...run({}), prompt: "a red fox" };
    expect((await orderByPrice(p.pricingRules("m"), p.availability("m"), long)).map((e) => e.upstream)).toEqual(["wavespeed"]);
    const browser = parsePricingRules(JSON.parse(JSON.stringify(p.pricingRules("m"))));
    expect(await rejectedInput(browser, "fal", long)).toEqual({ reason: "fal text maxLength 5" });
    expect(await estimateCost(browser, limited([false, true]).availability("m"), long, { mode: "default" })).toBeNull();
  });

  it("plans on the next upstream when the first refuses the run, and fails naming the reason when none takes it", async () => {
    const options = { idempotencyKey: "t1", sourceKeys: {}, clones: [], durations: { audio: [12] } };
    const input = { prompt: "hi", params: { audio: "https://a/x.mp3" } };
    const both = createMediaRunner(limited([true, true]), { mediaLimits: { maxMediaBytes: 1_000 }, pollIntervalMs: 0 });
    const planned = await both.plan("m", input, { mode: "upstream", upstream: "fal" }, options);
    expect(planned.state).toBe("failed");
    const reason = (planned as { reason: NoUpstreamAvailable }).reason;
    expect(reason).toBeInstanceOf(NoUpstreamAvailable);
    expect(reason.reasons).toEqual([{ upstream: "fal", kind: "unsupported_input", reason: "fal output stops at 241 frames" }]);
    const ordered = await both.plan("m", input, { mode: "cheapest" }, options);
    expect(ordered.state === "send" ? ordered.ticket.upstream : undefined).toBe("wavespeed");
  });

  it("keeps only the upstream whose condition fails to evaluate out, naming the condition's reason, and routes the run elsewhere", async () => {
    const p = createProvider({
      config: {
        upstreams: {
          wavespeed: { kind: "wavespeed", base_url: "https://w.example", key_env: "WAVESPEED_API_KEY" },
          fal: { kind: "fal", base_url: "https://f.example", billing_url: "https://f.example/v1", key_env: "FAL_KEY" },
        },
        media: {
          models: {
            m: {
              upstreams: [
                { upstream: "fal", weight: 1, model_id: "m", output_field: "audio", params: { tag: { field: "tag" } }, rejects: [{ when: "$contains(tag, /x/)", reason: "fal tag pattern" }], pricing: pricing(100) },
                { upstream: "wavespeed", weight: 2, model_id: "m", params: { tag: { field: "tag" } }, pricing: pricing(300) },
              ],
            },
          },
        },
      },
      keyOf: () => "k",
      llmMaxRetries: 0,
      cleanText: (t) => t,
    });
    const input = { ...run({ tag: 5 }), prompt: "" };
    expect(await rejectedInput(p.pricingRules("m"), "fal", input)).toEqual({ reason: "fal tag pattern", evaluationError: expect.any(String) });
    expect(await rejectedInput(p.pricingRules("m"), "wavespeed", input)).toBeUndefined();
    expect((await orderByPrice(p.pricingRules("m"), p.availability("m"), input)).map((e) => e.upstream)).toEqual(["wavespeed"]);
    expect((await estimateCost(p.pricingRules("m"), p.availability("m"), input, { mode: "default" }))?.upstream).toBe("wavespeed");
    const runner = createMediaRunner(p, { mediaLimits: { maxMediaBytes: 1_000 }, pollIntervalMs: 0 });
    const planned = await runner.plan("m", { prompt: "", params: { tag: 5 } }, { mode: "default" }, { idempotencyKey: "t1", sourceKeys: {}, clones: [], durations: {} });
    expect(planned.state === "send" ? planned.ticket.upstream : planned.state).toBe("wavespeed");
    expect(planned.warnings).toEqual([{ code: "input_check_failed", detail: { model: "m", upstream: "fal", reason: "fal tag pattern", error: expect.any(String) } }]);
  });

  describe("a source whose length the caller has not read", () => {
    /**
     * A provider where SandBase bills each second of the audio and WaveSpeed a flat price.
     * @returns The provider.
     */
    const perSecond = (): ReturnType<typeof createProvider> => createProvider({
      config: {
        upstreams: {
          wavespeed: { kind: "wavespeed", base_url: "https://w.example", key_env: "WAVESPEED_API_KEY" },
          sandbase: { kind: "sandbase", base_url: "https://s.example", key_env: "SANDBASE_API_KEY" },
        },
        media: {
          models: {
            m: {
              upstreams: [
                { upstream: "wavespeed", weight: 1, model_id: "m", params: { audio: { field: "audio" } }, pricing: { kind: "formula", base_price: 150_000, formula: "", discount_rate: 100 } },
                { upstream: "sandbase", weight: 2, model_id: "m", params: { audio: { field: "audio" } }, pricing: { kind: "formula", base_price: 300_000, formula: '{"total_price": base_price * get_duration(audio)}', discount_rate: 100 } },
              ],
            },
          },
        },
      },
      keyOf: () => "k",
      llmMaxRetries: 0,
      cleanText: (t) => t,
    });

    it("ranks an upstream that bills by its length after every upstream with a known price", async () => {
      const p = perSecond();
      const input = { ...run({ audio: "https://a/x.mp3" }), prompt: "", durationsMissing: ["audio"] };
      expect((await orderByPrice(p.pricingRules("m"), p.availability("m"), input)).map((e) => [e.upstream, e.bound])).toEqual([["wavespeed", "exact"], ["sandbase", "at_least"]]);
      expect((await estimateCost(p.pricingRules("m"), p.availability("m"), input, { mode: "cheapest" }))?.upstream).toBe("wavespeed");
    });

    it("plans cheapest mode on an upstream with a known price when the length is not passed", async () => {
      const runner = createMediaRunner(perSecond(), { mediaLimits: { maxMediaBytes: 1_000 }, pollIntervalMs: 0 });
      const planned = await runner.plan("m", { prompt: "", params: { audio: "https://a/x.mp3" } }, { mode: "cheapest" }, { idempotencyKey: "t1", sourceKeys: {}, clones: [], durations: {} });
      expect(planned.state === "send" ? planned.ticket.upstream : planned.state).toBe("wavespeed");
    });
  });

  it("takes no position on an upstream the rules do not list, and estimates on the next one", async () => {
    const p = bound();
    const input = run({});
    expect(await rejectedInput(p.pricingRules("m"), "elsewhere", input)).toBeUndefined();
    const availability = { ...p.availability("m"), upstreams: [{ upstream: "elsewhere", weight: 0, configured: true, envVar: "ELSEWHERE_KEY" }, ...p.availability("m").upstreams] };
    expect((await estimateCost(p.pricingRules("m"), availability, input, { mode: "default" }))?.upstream).toBe("wavespeed");
  });

  describe("an upstream whose price cannot be computed for the run", () => {
    /**
     * A provider where fal's formula multiplies by a param that may arrive as a string, and WaveSpeed's coerces it.
     * @returns The provider.
     */
    const unpriced = (): ReturnType<typeof createProvider> => createProvider({
      config: {
        upstreams: {
          wavespeed: { kind: "wavespeed", base_url: "https://w.example", key_env: "WAVESPEED_API_KEY" },
          fal: { kind: "fal", base_url: "https://f.example", billing_url: "https://f.example/v1", key_env: "FAL_KEY" },
        },
        media: {
          models: {
            m: {
              upstreams: [
                { upstream: "fal", weight: 1, model_id: "m", output_field: "video", params: { duration: { field: "duration" } }, pricing: { kind: "formula", base_price: 100, formula: '{"total_price": base_price * duration}', discount_rate: 100 } },
                { upstream: "wavespeed", weight: 2, model_id: "m", params: { duration: { field: "duration" } }, pricing: { kind: "formula", base_price: 300, formula: '{"total_price": base_price * $number(duration)}', discount_rate: 100 } },
              ],
            },
          },
        },
      },
      keyOf: () => "k",
      llmMaxRetries: 0,
      cleanText: (t) => t,
    });
    const input = { ...run({ duration: "5" }), prompt: "" };

    it("is kept out with the evaluation error, and every other upstream keeps its own rules", async () => {
      const p = unpriced();
      expect(await rejectedInput(p.pricingRules("m"), "fal", input)).toEqual({ reason: expect.any(String), evaluationError: expect.stringContaining("must evaluate to a number") });
      expect(await rejectedInput(p.pricingRules("m"), "wavespeed", input)).toBeUndefined();
    });

    it("leaves the price order and every mode's estimate to the others", async () => {
      const p = unpriced();
      expect((await orderByPrice(p.pricingRules("m"), p.availability("m"), input)).map((e) => e.upstream)).toEqual(["wavespeed"]);
      for (const mode of ["default", "cheapest"] as const) {
        expect(await estimateCost(p.pricingRules("m"), p.availability("m"), input, { mode })).toMatchObject({ upstream: "wavespeed", usd: expect.closeTo(0.0015, 9) });
      }
      expect(await estimateCost(p.pricingRules("m"), p.availability("m"), input, { mode: "upstream", upstream: "fal" })).toBeNull();
    });

    it("is kept out the same way when its formula gives no price for the run, so the route and the estimate agree", async () => {
      const p = unpriced();
      const blank = { ...run({}), prompt: "" };
      expect(await rejectedInput(p.pricingRules("m"), "fal", blank)).toEqual({ reason: expect.any(String), evaluationError: expect.any(String) });
      expect(await estimateCost(p.pricingRules("m"), p.availability("m"), blank, { mode: "default" })).toBeNull();
      const runner = createMediaRunner(p, { mediaLimits: { maxMediaBytes: 1_000 }, pollIntervalMs: 0 });
      const planned = await runner.plan("m", { prompt: "", params: {} }, { mode: "default" }, { idempotencyKey: "t1", sourceKeys: {}, clones: [], durations: {} });
      expect(planned.state).toBe("failed");
    });

    it("plans every mode on the others and says which upstream could not be checked", async () => {
      const runner = createMediaRunner(unpriced(), { mediaLimits: { maxMediaBytes: 1_000 }, pollIntervalMs: 0 });
      const options = { idempotencyKey: "t1", sourceKeys: {}, clones: [], durations: {} };
      for (const mode of ["default", "cheapest"] as const) {
        const planned = await runner.plan("m", { prompt: "", params: { duration: "5" } }, { mode }, options);
        expect(planned.state === "send" ? planned.ticket.upstream : planned.state).toBe("wavespeed");
        expect(planned.warnings).toEqual([{ code: "input_check_failed", detail: { model: "m", upstream: "fal", reason: expect.any(String), error: expect.stringContaining("must evaluate to a number") } }]);
      }
      const pinned = await runner.plan("m", { prompt: "", params: { duration: "5" } }, { mode: "upstream", upstream: "fal" }, options);
      expect(pinned.state).toBe("failed");
      expect(pinned.warnings).toEqual([{ code: "input_check_failed", detail: { model: "m", upstream: "fal", reason: expect.any(String), error: expect.stringContaining("must evaluate to a number") } }]);
    });
  });

  it("refuses a configuration whose condition is not JSONata, naming model, upstream and the condition", () => {
    const bad = (): unknown => createProvider({
      config: {
        upstreams: { fal: { kind: "fal", base_url: "https://f.example", billing_url: "https://f.example/v1", key_env: "FAL_KEY" } },
        media: { models: { m: { upstreams: [{ upstream: "fal", weight: 2, model_id: "m", output_field: "video", rejects: [{ when: "$length(", reason: "broken" }], pricing: pricing(1) }] } } },
      },
      keyOf: () => "k",
      llmMaxRetries: 0,
      cleanText: (t) => t,
    });
    expect(bad).toThrow(/m.*fal.*\$length\(/);
  });
});

describe("a model vendor's own input limits (model-level rejects)", () => {
  const SOURCE = "https://vendor.example/docs/limits";

  /**
   * A provider whose one model states two vendor limits in our param names; WaveSpeed sends `audio` as `audio`, fal
   * as `audio_url`, and fal names an audio reference `Audio {n}` in the prompt while WaveSpeed keeps the neutral one.
   * @param rejects - The model's limits.
   * @returns The provider.
   */
  const vendorBound = (rejects: { when: string; reason: string; source?: string }[] = [
    { when: "$length(prompt) > 10", reason: "Vendor prompt: up to 10 characters", source: SOURCE },
    { when: "get_duration(audio) > 10", reason: "Vendor audio: up to 10 seconds", source: SOURCE },
  ]): ReturnType<typeof createProvider> => createProvider({
    config: {
      upstreams: {
        wavespeed: { kind: "wavespeed", base_url: "https://w.example", key_env: "WAVESPEED_API_KEY" },
        fal: { kind: "fal", base_url: "https://f.example", billing_url: "https://f.example/v1", key_env: "FAL_KEY" },
      },
      media: {
        models: {
          m: {
            rejects: rejects as { when: string; reason: string; source: string }[],
            upstreams: [
              { upstream: "wavespeed", weight: 1, model_id: "m", prompt_field: "prompt", params: { audio: { field: "audio" } }, pricing: pricing(300) },
              { upstream: "fal", weight: 2, model_id: "m", prompt_field: "text", output_field: "video", params: { audio: { field: "audio_url" } }, mentions: { audio: "Audio {n}" }, pricing: pricing(100) },
            ],
          },
        },
      },
    },
    keyOf: () => "k",
    llmMaxRetries: 0,
    cleanText: (t) => t,
  });
  const audioRun = (seconds: number): EstimateInput => ({ params: { audio: "https://a/x.mp3" }, prompt: "hi", durations: { audio: [seconds] }, placeholders: [], durationsMissing: [] });

  it("refuses a run past a vendor limit on every upstream with the vendor's words, read in our param names", async () => {
    const p = vendorBound();
    for (const upstream of ["wavespeed", "fal"]) expect(await rejectedInput(p.pricingRules("m"), upstream, audioRun(11))).toEqual({ reason: "Vendor audio: up to 10 seconds" });
  });

  it("takes the nearest run the vendor allows", async () => {
    const p = vendorBound();
    for (const upstream of ["wavespeed", "fal"]) expect(await rejectedInput(p.pricingRules("m"), upstream, audioRun(10))).toBeUndefined();
  });

  it("reads the prompt as each upstream is sent it, its references written that upstream's way", async () => {
    const p = vendorBound();
    // fal is sent "Audio 1" (7 characters); WaveSpeed has no template and is sent the 15-character neutral reference.
    const input = { ...audioRun(5), prompt: "<<ref:audio:1>>" };
    expect(await rejectedInput(p.pricingRules("m"), "fal", input)).toBeUndefined();
    expect(await rejectedInput(p.pricingRules("m"), "wavespeed", input)).toEqual({ reason: "Vendor prompt: up to 10 characters" });
  });

  it("fails the plan naming the vendor's words for each upstream, sending nothing", async () => {
    const runner = createMediaRunner(vendorBound(), { mediaLimits: { maxMediaBytes: 1_000 }, pollIntervalMs: 0 });
    const planned = await runner.plan("m", { prompt: "hi", params: { audio: "https://a/x.mp3" } }, { mode: "default" }, { idempotencyKey: "t1", sourceKeys: {}, clones: [], durations: { audio: [11] } });
    expect(planned.state).toBe("failed");
    const reason = (planned as { reason: NoUpstreamAvailable }).reason;
    expect(reason).toBeInstanceOf(NoUpstreamAvailable);
    expect(reason.reasons).toEqual([
      { upstream: "wavespeed", kind: "unsupported_input", reason: "Vendor audio: up to 10 seconds" },
      { upstream: "fal", kind: "unsupported_input", reason: "Vendor audio: up to 10 seconds" },
    ]);
  });

  it("carries the limits to the browser, which refuses the run alike and estimates nothing", async () => {
    const p = vendorBound();
    const browser = parsePricingRules(JSON.parse(JSON.stringify(p.pricingRules("m"))));
    expect(await rejectedInput(browser, "fal", audioRun(11))).toEqual({ reason: "Vendor audio: up to 10 seconds" });
    expect(await estimateCost(browser, p.availability("m"), audioRun(11), { mode: "cheapest" })).toBeNull();
  });

  it("keeps every upstream out, with the evaluator's words, when a vendor limit cannot be checked on the run", async () => {
    const p = vendorBound([{ when: "$contains(tag, /x/)", reason: "Vendor tag pattern", source: SOURCE }]);
    const input = { ...audioRun(5), params: { tag: 5 } };
    for (const upstream of ["wavespeed", "fal"]) expect(await rejectedInput(p.pricingRules("m"), upstream, input)).toEqual({ reason: "Vendor tag pattern", evaluationError: expect.any(String) });
  });

  it.each([
    [{ when: "$length(prompt) > 10", reason: "Vendor prompt" }, /m.*source/],
    [{ when: "$length(prompt) > 10", reason: "Vendor prompt", source: "the vendor docs" }, /m.*source/],
    [{ when: "$length(", reason: "Vendor prompt", source: SOURCE }, /m.*\$length\(/],
  ])("refuses a configuration whose model-level limit %j is not a sourced JSONata condition", (reject, words) => {
    expect(() => vendorBound([reject])).toThrow(words);
  });
});
