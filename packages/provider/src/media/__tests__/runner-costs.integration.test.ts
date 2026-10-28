// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { Cost } from "../../cost.js";
import type { MediaBinding, ProviderConfigInput } from "../../config/schema.js";
import { costsOf, DeadlinePassed, SendNotAccepted, UpstreamTaskFailed } from "../../errors.js";
import { NoAnswer } from "../../http/errors.js";
import { createProvider, type Provider } from "../../provider.js";
import type { Route } from "../../routing/route.js";
import { createMediaRunner, type MediaAnswer, type MediaRunner, type MediaTicket } from "../runner.js";
import { accepted, billedIds, billing, fakeUpstream, finishedAtOnce, result, submits, type FakeUpstream } from "./fake-upstream.js";

// Every billed answer reaches the caller once, whatever way the run ends (DD 33).

const pricing = { kind: "formula", base_price: 0, formula: "", discount_rate: 100 };
const DEFAULT: Route = { mode: "default" };
const POLL_MS = 3_000;

let a: FakeUpstream;
let b: FakeUpstream;

beforeEach(async () => {
  a = await fakeUpstream();
  b = await fakeUpstream();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([a.close(), b.close()]);
});

/**
 * One binding of a model on one of the fakes.
 * @param upstream - The upstream.
 * @param weight - Its weight.
 * @param extra - The rest of the binding.
 * @returns The binding.
 */
const bound = (upstream: string, weight: number, extra: Partial<MediaBinding>): MediaBinding => ({ upstream, weight, model_id: "bytedance/seedance", params: {}, pricing, ...extra });

const voiceClone: Partial<MediaBinding> = {
  model_id: "minimax/voice-clone",
  params: { audio: { field: "audio" } },
  reused_by: "audio",
  extra_steps: [{ kind: "speak", endpoint: "minimax/speech-2.8-hd", at: "after" }],
};

/**
 * The configuration of these cases.
 * @returns The raw configuration.
 */
function config(): ProviderConfigInput {
  return {
    upstreams: {
      ws_a: { kind: "wavespeed", base_url: a.url, key_env: "WS_A_KEY" },
      ws_b: { kind: "wavespeed", base_url: b.url, key_env: "WS_B_KEY" },
    },
    media: {
      models: {
        seedance: { upstreams: [bound("ws_a", 1, { prompt_field: "prompt" }), bound("ws_b", 2, { prompt_field: "prompt" })] },
        "voice-clone": { upstreams: [bound("ws_a", 1, voiceClone), bound("ws_b", 2, voiceClone)] },
      },
    },
  };
}

/**
 * The provider over the fakes.
 * @returns The provider.
 */
function provider(): Provider {
  const keys: Record<string, string> = { WS_A_KEY: "key-a", WS_B_KEY: "key-b" };
  return createProvider({ config: config(), keyOf: (name) => keys[name], llmMaxRetries: 2, cleanText: (t) => t });
}

/**
 * A runner over the fakes.
 * @returns The runner.
 */
const runner = (): MediaRunner => createMediaRunner(provider(), { mediaLimits: { maxMediaBytes: 1_000_000 }, pollIntervalMs: POLL_MS });

const stored = (ticket: MediaTicket): MediaTicket => JSON.parse(JSON.stringify(ticket)) as MediaTicket;
const live = (): { deadlineAt: number } => ({ deadlineAt: Date.now() + 60_000 });
const options = { idempotencyKey: "task-1", sourceKeys: { "https://cdn.example/a.mp3": "sha-a" }, clones: [] };
const video = { prompt: "a fox in snow", params: {} };
const speech = { prompt: "hello there", params: { audio: "https://cdn.example/a.mp3" } };

/**
 * Narrow an answer to one state, failing the case otherwise.
 * @param answer - The answer.
 * @param state - The state expected.
 * @returns The answer, narrowed.
 */
function expectState<S extends MediaAnswer["state"]>(answer: MediaAnswer, state: S): Extract<MediaAnswer, { state: S }> {
  expect(answer.state).toBe(state);
  return answer as Extract<MediaAnswer, { state: S }>;
}

/**
 * Plan the video run and send its submit.
 * @param r - The runner.
 * @returns What the send answered, or what it threw.
 */
async function submitVideo(r: MediaRunner): Promise<MediaAnswer | unknown> {
  const planned = expectState(await r.plan("seedance", video, DEFAULT, options), "send");
  return r.send(stored(planned.ticket), live()).catch((e: unknown) => e);
}

const lookupOf = (predictionId: string, upstream = "ws_a"): unknown => ({ state: "pending", lookup: { upstream, predictionId } });

describe("a submit answered 2xx whose answer cannot be read is sent with its outcome unknown (DD 33)", () => {
  it.each([
    ["not JSON", (): void => a.answer(() => ({ status: 200, raw: "<html>ok</html>", contentType: "text/html" }))],
    ["no id and no outputs", (): void => a.answer(() => ({ status: 200, body: { code: 200, data: { status: "created" } } }))],
    ["an id that is not a string", (): void => a.answer(() => ({ status: 200, body: { code: 200, data: { id: 123, status: "created", outputs: [] } } }))],
    ["a body cut before its end", (): void => a.answer(() => ({ status: 200, raw: "{\"code\":200,\"data\":{\"id\":\"p", contentType: "application/json", hold: true }))],
  ])("%s: throws NoAnswer carrying one missing cost, and moves to no other upstream", async (_name, answer) => {
    answer();
    b.answer(() => accepted("p-b"));
    const r = runner();
    const planned = expectState(await r.plan("seedance", video, DEFAULT, options), "send");
    const error = await r.send(stored(planned.ticket), { deadlineAt: Date.now() + 1_500 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoAnswer);
    expect(costsOf(error)).toEqual([expect.objectContaining({ state: "missing" })]);
    expect(submits(b.seen)).toHaveLength(0);
    a.release();
  });

  it("the next pickup recovers the ticket with the duplicate-cost warning", async () => {
    a.answer(() => ({ status: 200, raw: "<html>ok</html>", contentType: "text/html" }));
    const r = runner();
    const planned = expectState(await r.plan("seedance", video, DEFAULT, options), "send");
    await r.send(stored(planned.ticket), live()).catch(() => undefined);
    const recovered = expectState(await r.recover(stored(planned.ticket), live()), "send");
    expect(recovered.warnings.map((w) => w.code)).toContain("potential_duplicate_cost");
  });
});

describe("a submit that finished at once without a prediction id to bill (DD 33)", () => {
  it("answers done with one missing cost", async () => {
    a.answer(({ path }) => (path === "/billings/search" ? billing([]) : { status: 200, body: { code: 200, data: { status: "completed", outputs: ["https://out.example/v.mp4"] } } }));
    const done = expectState(await submitVideo(runner()) as MediaAnswer, "done");
    expect(done.costs).toEqual([expect.objectContaining({ state: "missing" })]);
    expect(billedIds(a.seen)).toEqual([]);
  });
});

describe("a failed run hands back a lookup for every prediction an upstream accepted (DD 33)", () => {
  it("when the upstream fails the prediction", async () => {
    a.answer(({ method }) => (method === "POST" ? accepted("p1") : result("p1", "failed", [], "boom")));
    const r = runner();
    const running = expectState(await submitVideo(r) as MediaAnswer, "running");
    const failed = expectState(await r.poll(stored(running.ticket), live()), "failed");
    expect(failed.reason).toBeInstanceOf(UpstreamTaskFailed);
    expect(failed.costs).toEqual([lookupOf("p1")]);
  });

  it("when the finished prediction carries no output", async () => {
    a.answer(({ method }) => (method === "POST" ? accepted("p1") : result("p1", "completed", [])));
    const r = runner();
    const running = expectState(await submitVideo(r) as MediaAnswer, "running");
    const failed = expectState(await r.poll(stored(running.ticket), live()), "failed");
    expect(failed.costs).toEqual([lookupOf("p1")]);
  });

  it("when a submit that finished at once carries no usable output", async () => {
    a.answer(() => finishedAtOnce("p1", [{ not: "a url" }]));
    const failed = expectState(await submitVideo(runner()) as MediaAnswer, "failed");
    expect(failed.costs).toEqual([lookupOf("p1")]);
  });

  it("for the steps done before the one that failed as well", async () => {
    a.answer(({ method, path }) => {
      if (method === "POST") return path === "/minimax/voice-clone" ? accepted("p-voice") : accepted("p-speak");
      return path.includes("p-voice") ? result("p-voice", "completed", []) : result("p-speak", "failed", [], "boom");
    });
    const r = runner();
    let answer: MediaAnswer = await r.plan("voice-clone", speech, DEFAULT, options);
    for (let turn = 0; turn < 6 && (answer.state === "send" || answer.state === "running"); turn++) {
      answer = answer.state === "send" ? await r.send(stored(answer.ticket), live()) : await r.poll(stored(answer.ticket), live());
    }
    const failed = expectState(answer, "failed");
    expect(failed.costs).toEqual([lookupOf("p-voice"), lookupOf("p-speak")]);
  });
});

describe("abandon: what a ticket cost when its task ends on a throw (design 3.4, DD 33)", () => {
  it("hands back a lookup for the accepted prediction of a running ticket", async () => {
    a.answer(() => accepted("p1"));
    const r = runner();
    const running = expectState(await submitVideo(r) as MediaAnswer, "running");
    expect(r.abandon(stored(running.ticket)).costs).toEqual([lookupOf("p1")]);
  });

  it("hands back nothing for a ticket no upstream accepted", async () => {
    const planned = expectState(await runner().plan("seedance", video, DEFAULT, options), "send");
    expect(runner().abandon(stored(planned.ticket)).costs).toEqual([]);
  });

  it("hands back the done steps of a run whose next step was refused at the deadline", async () => {
    a.answer(({ method, path }) => (method === "POST" ? (path === "/minimax/voice-clone" ? accepted("p-voice") : "hang") : result("p-voice", "completed", [])));
    const r = runner();
    const sent = expectState(await r.send(stored(expectState(await r.plan("voice-clone", speech, DEFAULT, options), "send").ticket), live()), "running");
    const next = expectState(await r.poll(stored(sent.ticket), live()), "send");
    const error = await r.send(stored(next.ticket), { deadlineAt: Date.now() + 300 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeadlinePassed);
    expect(costsOf(error)).toEqual([]);
    expect(r.abandon(stored(next.ticket)).costs).toEqual([lookupOf("p-voice")]);
    a.release();
  });
});

describe("an asynchronously accepted step pins the run to its upstream (design 5.2)", () => {
  it("a later step's 503 is retried on the same upstream, not moved", async () => {
    a.answer(({ method, path }) => {
      if (method === "POST") return path === "/minimax/voice-clone" ? accepted("p-voice") : { status: 503, body: {} };
      return result("p-voice", "completed", []);
    });
    b.answer(() => accepted("p-b"));
    vi.spyOn(Math, "random").mockReturnValue(0);
    const r = runner();
    const sent = expectState(await r.send(stored(expectState(await r.plan("voice-clone", speech, DEFAULT, options), "send").ticket), live()), "running");
    const next = expectState(await r.poll(stored(sent.ticket), live()), "send");
    await expect(r.send(stored(next.ticket), live())).rejects.toBeInstanceOf(SendNotAccepted);
    expect(submits(b.seen)).toHaveLength(0);
  });
});

describe("a submit refused for now is delivered three times before the run moves (DD 24)", () => {
  it.each([408, 429])("%i", async (status) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    a.answer(() => ({ status, body: {} }));
    const moved = expectState(await submitVideo(runner()) as MediaAnswer, "send");
    expect(moved.warnings.map((w) => w.code)).toContain("upstream_switched");
    expect(submits(a.seen)).toHaveLength(3);
  });
});

describe("billing", () => {
  it("asks again within the lookup when the billing search answers 503, as a replay-safe read (design 2.2)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let searches = 0;
    a.answer(({ path }) => {
      if (path !== "/billings/search") return finishedAtOnce("p1", ["https://out.example/v.mp4"]);
      return ++searches === 1 ? { status: 503, body: {} } : billing([{ type: "deduct", price: 0.2 }]);
    });
    const done = expectState(await submitVideo(runner()) as MediaAnswer, "done");
    expect(done.costs).toEqual([{ state: "known", usd: 0.2, source: "billing" }]);
    expect(searches).toBe(2);
  });

  it("carries the words of a failure whose error is not a string", async () => {
    a.answer(({ method }) => (method === "POST" ? accepted("p1") : { status: 200, body: { code: 200, data: { id: "p1", status: "failed", outputs: [], error: 42 } } }));
    const r = runner();
    const running = expectState(await submitVideo(r) as MediaAnswer, "running");
    const failed = expectState(await r.poll(stored(running.ticket), live()), "failed");
    expect((failed.reason as UpstreamTaskFailed).upstreamError).toBe("42");
  });
});

describe("a legacy step's inline cost (design 3.4)", () => {
  it("is carried as a reported cost beside the billing of the predictions", async () => {
    a.answer(({ method, path }) => {
      if (path === "/billings/search") return billing([{ type: "deduct", price: 0.1 }]);
      return method === "POST" ? accepted("p-speak") : result("p-speak", "completed", ["https://out.example/s.mp3"]);
    });
    const legacy = {
      steps: [
        { position: 0, kind: "voice" as const, endpoint: "minimax/voice-clone", itemIndex: null, status: "done" as const, predictionId: "p-voice", output: { voiceId: "BreaticOld", prediction: "p-voice" }, inlineCostUsd: 0.12 },
        { position: 1, kind: "speak" as const, endpoint: "minimax/speech-2.8-hd", itemIndex: null, status: "pending" as const, predictionId: null, output: {}, inlineCostUsd: 0 },
      ],
    };
    const r = runner();
    const next = expectState(await r.ticketFromLegacy("voice-clone", speech, DEFAULT, options, legacy), "send");
    const speaking = expectState(await r.send(stored(next.ticket), live()), "running");
    const done = expectState(await r.poll(stored(speaking.ticket), live()), "done");
    expect(done.costs).toContainEqual({ state: "known", usd: 0.12, source: "reported" });
  });
});

describe("pacing and the deadline", () => {
  it("asks again after the caller's poll interval", async () => {
    a.answer(({ method }) => (method === "POST" ? accepted("p1") : result("p1", "processing")));
    const r = runner();
    const running = expectState(await submitVideo(r) as MediaAnswer, "running");
    const before = Date.now();
    const again = expectState(await r.poll(stored(running.ticket), live()), "running");
    expect(again.askAgainAt).toBeGreaterThanOrEqual(before + POLL_MS);
    expect(again.askAgainAt).toBeLessThanOrEqual(Date.now() + POLL_MS);
  });

  it("requires the poll interval", () => {
    // @ts-expect-error pollIntervalMs is required: a missing one asked again at once.
    expect(() => createMediaRunner(provider(), { mediaLimits: { maxMediaBytes: 1 } })).not.toThrow();
  });

  it("calls a submit cut by its deadline timer DeadlinePassed, though the clock reads a moment before it", async () => {
    a.answer(() => "hang");
    const r = runner();
    const planned = expectState(await r.plan("seedance", video, DEFAULT, options), "send");
    const real = Date.now.bind(Date);
    const started = real();
    const deadlineAt = started + 300;
    // The timer fires on time; the clock read after it lags, as a timer firing early would see it.
    vi.spyOn(Date, "now").mockImplementation(() => (real() >= started + 200 ? real() - 150 : real()));
    await expect(r.send(stored(planned.ticket), { deadlineAt })).rejects.toBeInstanceOf(DeadlinePassed);
  });
});

describe("a run's billed predictions reach the caller once, however it ends (design 13.1, DD 33, critical path)", () => {
  const SUBMITS = ["accept", "finishNow", "busy", "refused", "unreadable"] as const;
  const POLLS = ["processing", "completed", "failed"] as const;

  it("property: whatever the submits and polls answer", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom(...SUBMITS), { maxLength: 6 }), fc.array(fc.constantFrom(...POLLS), { maxLength: 6 }), async (submitScript, pollScript) => {
        vi.spyOn(Math, "random").mockReturnValue(0);
        let s = 0;
        let p = 0;
        let acceptedCount = 0;
        let unreadable = 0;
        const fake = ({ method, path }: { method: string; path: string }): ReturnType<typeof accepted> => {
          if (path === "/billings/search") return billing([{ type: "deduct", price: 0.1 }]);
          const id = path.split("/")[2] ?? "";
          if (method !== "POST") {
            const next = pollScript[p++] ?? "completed";
            return next === "completed" ? result(id, "completed", ["https://out.example/s.mp3"]) : next === "failed" ? result(id, "failed", [], "boom") : result(id, "processing");
          }
          const next = submitScript[s++] ?? "accept";
          if (next === "accept" || next === "finishNow") {
            acceptedCount++;
            return next === "accept" ? accepted(`p-${s}`) : finishedAtOnce(`p-${s}`, ["https://out.example/s.mp3"]);
          }
          if (next === "unreadable") {
            unreadable++;
            return { status: 200, raw: "<html>", contentType: "text/html" };
          }
          return next === "busy" ? { status: 503, body: {} } : { status: 400, body: { message: "bad" } };
        };
        a.answer(fake);
        b.answer(fake);
        const r = runner();
        const reached: Cost[] = [];
        let answer: MediaAnswer = await r.plan("voice-clone", speech, DEFAULT, options);
        for (let turn = 0; turn < 16 && (answer.state === "send" || answer.state === "running"); turn++) {
          const ticket = stored((answer as { ticket: MediaTicket }).ticket);
          if (answer.state === "running") {
            answer = await r.poll(ticket, live());
            continue;
          }
          try {
            answer = await r.send(ticket, live());
          } catch (error) {
            reached.push(...costsOf(error));
            if (error instanceof NoAnswer) answer = await r.recover(ticket, live());
            else if (!(error instanceof SendNotAccepted)) throw error;
          }
        }
        if (answer.state === "done" || answer.state === "failed") reached.push(...answer.costs);
        else reached.push(...r.abandon(stored((answer as { ticket: MediaTicket }).ticket)).costs);
        const billingEntries = reached.filter((c) => (c.state === "known" && c.source === "billing") || (c.state === "pending" && typeof c.lookup.predictionId === "string")).length;
        expect(billingEntries).toBe(acceptedCount);
        expect(reached.filter((c) => c.state === "missing")).toHaveLength(unreadable);
      }),
      { numRuns: 40 },
    );
  });
});
