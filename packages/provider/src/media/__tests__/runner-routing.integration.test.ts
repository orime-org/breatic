// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { MediaBinding, ProviderConfigInput } from "../../config/schema.js";
import { NoUpstreamAvailable, SendNotAccepted } from "../../errors.js";
import { estimateCost, orderByPrice, rejectedInput } from "../../pricing/estimate.js";
import { createProvider } from "../../provider.js";
import type { Route } from "../../routing/route.js";
import { createMediaRunner, type MediaAnswer, type MediaTicket, type PlanOptions } from "../runner.js";
import { accepted, fakeUpstream, type FakeUpstream, type Reply } from "./fake-upstream.js";

// Which upstream a run is sent to: one that can take its input, in the route's order, and a lasting refusal
// from the last one ends the run.

const NAMES = ["ws", "fal", "sandbase"] as const;
type Name = (typeof NAMES)[number];
const KINDS: Record<Name, string> = { ws: "wavespeed", fal: "fal", sandbase: "sandbase" };
const ENVS: Record<Name, string> = { ws: "WS_KEY", fal: "FAL_KEY", sandbase: "SANDBASE_API_KEY" };
const DURATIONS = [5, 10, 15] as const;
const VOICES = ["Alicia", "Adam", "Warren"] as const;

let fakes: Record<Name, FakeUpstream>;

beforeEach(async () => {
  fakes = { ws: await fakeUpstream(), fal: await fakeUpstream(), sandbase: await fakeUpstream() };
});

afterEach(async () => {
  await Promise.all(Object.values(fakes).map((f) => f.close()));
});

/** One upstream's limits on the run's input, as a binding writes them. */
interface Limits {
  /** `params.duration.supported`, when set. */
  durations: number[] | null;
  /** `drops.web`: the values it serves although it has no field for web; null when it binds web. */
  webDrop: boolean[] | null;
  /** The voices of `voice_map.voice_id`, when set. */
  voices: string[] | null;
  /** The longest audio it takes, as a `rejects` condition on the clip length; null for none. */
  maxAudio: number | null;
}

/** How one upstream answers a submit. */
type Answer = "accept" | "busy" | "balance" | "noModel";

/**
 * One upstream's binding of the model.
 * @param name - The upstream.
 * @param weight - Its weight.
 * @param limits - Its input limits.
 * @param price - Its flat price, in millionths of a dollar.
 * @returns The binding.
 */
function binding(name: Name, weight: number, limits: Limits, price: number): MediaBinding {
  return {
    upstream: name,
    weight,
    model_id: "m",
    prompt_field: "prompt",
    params: {
      duration: { field: "duration", ...(limits.durations === null ? {} : { supported: limits.durations }) },
      voice_id: { field: "voice" },
      audio: { field: "audio" },
      ...(limits.webDrop === null ? { web: { field: "web" } } : {}),
    },
    ...(limits.maxAudio === null ? {} : { rejects: [{ when: `get_duration(audio) > ${limits.maxAudio}`, reason: `audio up to ${limits.maxAudio} s` }] }),
    ...(limits.webDrop === null ? {} : { drops: { web: limits.webDrop } }),
    ...(limits.voices === null ? {} : { voice_map: { voice_id: Object.fromEntries(limits.voices.map((v) => [v, v.toLowerCase()])) } }),
    ...(name === "fal" ? { output_field: "video" } : {}),
    pricing: { kind: "formula", base_price: price, formula: "", discount_rate: 100 },
  };
}

/**
 * The fake's answer to a submit, in its upstream's own words.
 * @param name - The upstream.
 * @param answer - How it answers.
 * @returns The reply.
 */
function submitReply(name: Name, answer: Answer): Reply {
  if (answer === "busy") return { status: 503, body: {} };
  if (name === "ws") return answer === "accept" ? accepted("w1") : { status: 400, body: { code: 400, message: "Model not found." } };
  if (name === "fal") {
    if (answer === "accept") return { status: 200, body: { request_id: "f1", status_url: `${fakes.fal.url}/m/requests/f1/status`, response_url: `${fakes.fal.url}/m/requests/f1` } };
    if (answer === "balance") return { status: 403, body: { detail: "User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing." } };
    return { status: 404, body: { detail: 'Application "m" not found' } };
  }
  if (answer === "accept") return { status: 202, body: { id: "s1", status: "pending" } };
  if (answer === "balance") return { status: 402, body: { error: "insufficient balance" } };
  return { status: 404, body: { error: "model not found: m" } };
}

const limitsArb: fc.Arbitrary<Limits> = fc.record({
  durations: fc.option(fc.subarray([...DURATIONS], { minLength: 1 })),
  webDrop: fc.option(fc.subarray([true, false])),
  voices: fc.option(fc.subarray([...VOICES], { minLength: 1 })),
  maxAudio: fc.option(fc.constantFrom(10, 30)),
});

describe("plan options", () => {
  it("require the clip lengths, which every mode's rejects read", () => {
    // @ts-expect-error durations is required
    const withoutDurations: PlanOptions = { idempotencyKey: "t", sourceKeys: {}, clones: [] };
    expect(withoutDurations.durations).toBeUndefined();
  });
});

describe("a run is sent only where its input can go (critical path)", () => {
  it("property: whatever the weights and the deployment's overrides of them, keys, input limits, request values, submit answers and restarts between sends", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 0, max: 9 }), { minLength: 3, maxLength: 3 }),
        // A key is present more often than not, so runs reach the submits as well as the refusals.
        fc.tuple(...NAMES.map(() => fc.constantFrom(true, true, true, false))),
        fc.tuple(limitsArb, limitsArb, limitsArb),
        fc.tuple(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 1000 })),
        fc.record({ duration: fc.constantFrom(5, 10, 15, null, null), web: fc.constantFrom(true, false, null, null), voice_id: fc.constantFrom("Alicia", "Adam", "Warren", null, null), audio: fc.constantFrom("https://cdn.example/a.mp3", null) }),
        fc.constantFrom(5, 20, 45),
        fc.tuple(fc.constantFrom<Answer>("accept", "busy", "noModel"), fc.constantFrom<Answer>("accept", "busy", "balance", "noModel"), fc.constantFrom<Answer>("accept", "busy", "balance", "noModel")),
        fc.oneof(
          { arbitrary: fc.constant<Route>({ mode: "default" }), weight: 3 },
          { arbitrary: fc.constant<Route>({ mode: "cheapest" }), weight: 2 },
          { arbitrary: fc.constantFrom(...NAMES.map((upstream): Route => ({ mode: "upstream", upstream }))), weight: 1 },
        ),
        // The deployment's routing.yaml: a new weight for some upstreams, outside the shipped ones so none repeats.
        fc.tuple(...NAMES.map(() => fc.option(fc.integer({ min: 10, max: 12 }), { nil: undefined }))).filter((o) => new Set(o.filter((w) => w !== undefined)).size === o.filter((w) => w !== undefined).length),
        // Before which sends the process restarts, the ticket read back by a new provider instance.
        fc.array(fc.boolean(), { maxLength: 4 }),
        // The model vendor's own audio limit, checked on every upstream before any binding's: none, or the longest clip it takes.
        fc.option(fc.integer({ min: 1, max: 30 }), { nil: null }),
        async (shipped, keyed, limits, prices, params, audioSeconds, answers, route, overrides, restarts, vendorMax) => {
          const weights = NAMES.map((_, i) => overrides[i] ?? shipped[i]!);
          const overridden = Object.fromEntries(NAMES.flatMap((n, i) => (overrides[i] === undefined ? [] : [[n, overrides[i]]])));
          const config: ProviderConfigInput = {
            upstreams: Object.fromEntries(NAMES.map((n) => [n, { kind: KINDS[n], base_url: fakes[n].url, key_env: ENVS[n], ...(n === "fal" ? { billing_url: `${fakes[n].url}/v1` } : {}) }])),
            media: {
              models: {
                m: {
                  ...(vendorMax === null ? {} : { rejects: [{ when: `get_duration(audio) > ${vendorMax}`, reason: "vendor audio limit", source: "https://vendor.example/limits" }] }),
                  upstreams: NAMES.map((n, i) => binding(n, shipped[i]!, limits[i]!, prices[i]!)),
                },
              },
            },
            ...(Object.keys(overridden).length === 0 ? {} : { routing: { models: { m: { weights: overridden } } } }),
          };
          const keys = Object.fromEntries(NAMES.flatMap((n, i) => (keyed[i] ? [[ENVS[n], "key"]] : [])));
          /**
           * A provider instance and its runner, as one process starts them.
           * @returns Both.
           */
          const started = (): { provider: ReturnType<typeof createProvider>; runner: ReturnType<typeof createMediaRunner> } => {
            const provider = createProvider({ config, keyOf: (env) => keys[env], llmMaxRetries: 0, cleanText: (t) => t });
            return { provider, runner: createMediaRunner(provider, { mediaLimits: { maxMediaBytes: 1_000_000 }, pollIntervalMs: 0 }) };
          };
          const { provider } = started();
          let { runner } = started();
          const submitted: Name[] = [];
          for (const [i, name] of NAMES.entries()) {
            fakes[name].answer(({ method }) => {
              if (method !== "POST") return undefined;
              submitted.push(name);
              return submitReply(name, answers[i]!);
            });
          }
          const rules = provider.pricingRules("m");
          const input = { prompt: "a fox", params };
          // Every mode reads the clip lengths: each upstream's rejects do, and cheapest-mode prices.
          const durations: Record<string, number[]> = params.audio === null ? {} : { audio: [audioSeconds] };
          const prepared = { ...input, durations, placeholders: [], durationsMissing: [] };
          const refusal = new Map(await Promise.all(NAMES.map(async (n) => [n, await rejectedInput(rules, n, prepared)] as const)));
          const takes = (name: Name): boolean => keyed[NAMES.indexOf(name)]! && refusal.get(name) === undefined;
          // The order the route tries: configured upstreams that can take the input.
          const expected: Name[] = route.mode === "upstream"
            ? NAMES.filter((n) => n === route.upstream && takes(n))
            : route.mode === "cheapest"
              ? (await orderByPrice(rules, provider.availability("m"), prepared)).map((e) => e.upstream as Name)
              : NAMES.filter(takes).sort((x, y) => weights[NAMES.indexOf(x)]! - weights[NAMES.indexOf(y)]!);

          let answer: MediaAnswer = await runner.plan("m", input, route, { idempotencyKey: "task-1", sourceKeys: {}, clones: [], durations });
          let notAccepted = false;
          for (let sends = 0; answer.state === "send"; sends++) {
            if (restarts[sends] === true) runner = started().runner;
            try {
              answer = await runner.send(JSON.parse(JSON.stringify(answer.ticket)) as MediaTicket, { deadlineAt: Date.now() + 60_000 });
            } catch (error) {
              if (!(error instanceof SendNotAccepted)) throw error;
              notAccepted = true;
              break;
            }
          }

          const estimate = await estimateCost(rules, provider.availability("m"), prepared, route);
          if (vendorMax !== null && params.audio !== null && audioSeconds > vendorMax) {
            // Past the vendor's limit no upstream takes the run: nothing is sent, and each configured upstream the route
            // reads refuses it, with the vendor's reason unless a value it cannot take was found first.
            expect(expected).toEqual([]);
            expect(submitted).toEqual([]);
            expect(answer.state).toBe("failed");
            const reason = (answer as Extract<MediaAnswer, { state: "failed" }>).reason;
            expect(reason).toBeInstanceOf(NoUpstreamAvailable);
            const read = NAMES.filter((n) => (route.mode !== "upstream" || route.upstream === n) && keyed[NAMES.indexOf(n)]!);
            for (const n of read) {
              const own = (reason as NoUpstreamAvailable).reasons.find((r) => r.upstream === n);
              expect(own, n).toEqual(refusal.get(n) !== undefined && "param" in refusal.get(n)! ? expect.objectContaining({ kind: "unsupported_input", param: expect.any(String) }) : { upstream: n, kind: "unsupported_input", reason: "vendor audio limit" });
            }
            expect(estimate).toBeNull();
            return;
          }
          if (expected.length === 0) {
            // No upstream can take it: nothing is sent, and each configured upstream that refuses the input says so.
            expect(submitted).toEqual([]);
            expect(answer.state).toBe("failed");
            const reason = (answer as Extract<MediaAnswer, { state: "failed" }>).reason;
            expect(reason).toBeInstanceOf(NoUpstreamAvailable);
            const refusing = NAMES.filter((n) => (route.mode !== "upstream" || route.upstream === n) && keyed[NAMES.indexOf(n)]! && refusal.get(n) !== undefined);
            for (const n of refusing) expect((reason as NoUpstreamAvailable).reasons).toContainEqual(expect.objectContaining({ upstream: n, kind: "unsupported_input" }));
            expect(estimate).toBeNull();
            return;
          }
          // The first upstream sent to can take the input, and is the one the estimate priced.
          expect(refusal.get(submitted[0]!)).toBeUndefined();
          expect(estimate?.upstream).toBe(submitted[0]);
          // Each upstream is tried once, in the route's order, until one accepts or the last one refuses.
          const stopAt = expected.findIndex((n) => answers[NAMES.indexOf(n)] === "accept");
          expect(submitted).toEqual(stopAt < 0 ? expected : expected.slice(0, stopAt + 1));
          for (const n of submitted) expect(refusal.get(n)).toBeUndefined();
          const last = answers[NAMES.indexOf(submitted.at(-1)!)];
          if (last === "accept") expect(answer.state).toBe("running");
          else if (last === "busy") expect(notAccepted).toBe(true);
          else {
            // A lasting refusal from the last candidate fails the run: no SendNotAccepted, no retry.
            expect(notAccepted).toBe(false);
            expect(answer.state).toBe("failed");
            expect((answer as Extract<MediaAnswer, { state: "failed" }>).reason).toBeInstanceOf(NoUpstreamAvailable);
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
