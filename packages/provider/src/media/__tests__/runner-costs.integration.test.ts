// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { Cost } from "../../cost.js";
import type { MediaBinding, ProviderConfigInput } from "../../config/schema.js";
import { costsOf, DeadlinePassed, SendNotAccepted, UpstreamTaskFailed } from "../../errors.js";
import { Aborted, NoAnswer } from "../../http/errors.js";
import { SIDE_REQUEST_MS } from "../../http/request.js";
import { createProvider, type Provider } from "../../provider.js";
import type { Route } from "../../routing/route.js";
import { createMediaRunner, type MediaAnswer, type MediaRunner, type MediaTicket } from "../runner.js";
import { accepted, billedIds, billing, fakeUpstream, finishedAtOnce, result, submits, type FakeUpstream, type Reply } from "./fake-upstream.js";

// Every billed answer reaches the caller once, whatever way the run ends.

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
const options = { idempotencyKey: "task-1", sourceKeys: { "https://cdn.example/a.mp3": "sha-a" }, clones: [], durations: {} };
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

describe("a submit answered 2xx whose answer cannot be read is sent with its outcome unknown", () => {
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

describe("a submit that finished at once without a prediction id to bill", () => {
  it("answers done with one missing cost", async () => {
    a.answer(({ path }) => (path === "/billings/search" ? billing([]) : { status: 200, body: { code: 200, data: { status: "completed", outputs: ["https://out.example/v.mp4"] } } }));
    const done = expectState(await submitVideo(runner()) as MediaAnswer, "done");
    expect(done.costs).toEqual([expect.objectContaining({ state: "missing" })]);
    expect(billedIds(a.seen)).toEqual([]);
  });
});

describe("a failed run hands back a lookup for every prediction an upstream accepted", () => {
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

describe("abandon: what a ticket cost when its task ends on a throw", () => {
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

describe("an asynchronously accepted step pins the run to its upstream", () => {
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

describe("a submit refused for now is delivered three times before the run moves", () => {
  it.each([408, 429])("%i", async (status) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    a.answer(() => ({ status, body: {} }));
    const moved = expectState(await submitVideo(runner()) as MediaAnswer, "send");
    expect(moved.warnings.map((w) => w.code)).toContain("upstream_switched");
    expect(submits(a.seen)).toHaveLength(3);
  });
});

describe("billing", () => {
  it("asks again within the lookup when the billing search answers 503, as a replay-safe read", async () => {
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
});

describe("a failed prediction's words", () => {
  it("carries the words of a failure whose error is not a string", async () => {
    a.answer(({ method }) => (method === "POST" ? accepted("p1") : { status: 200, body: { code: 200, data: { id: "p1", status: "failed", outputs: [], error: 42 } } }));
    const r = runner();
    const running = expectState(await submitVideo(r) as MediaAnswer, "running");
    const failed = expectState(await r.poll(stored(running.ticket), live()), "failed");
    expect((failed.reason as UpstreamTaskFailed).upstreamError).toBe("42");
  });
});

describe("a legacy step's inline cost", () => {
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

describe("a billing read is a side request", () => {
  it("hands back a finished run within the side-request limit while its billing endpoint hangs, its cost pending", async () => {
    a.answer(({ method, path }) => (path === "/billings/search" ? "hang" : method === "POST" ? accepted("p1") : result("p1", "completed", ["https://out.example/v.mp4"])));
    const r = runner();
    const running = expectState(await submitVideo(r) as MediaAnswer, "running");
    const started = Date.now();
    const done = expectState(await r.poll(stored(running.ticket), { deadlineAt: started + 600_000 }), "done");
    expect(Date.now() - started).toBeLessThan(SIDE_REQUEST_MS + 5_000);
    expect(done.costs).toEqual([lookupOf("p1")]);
  }, 60_000);

  it("hands back a finished run of two predictions within one side-request limit while its billing endpoint hangs", async () => {
    a.answer(({ method, path }) => {
      if (path === "/billings/search") return "hang";
      if (method === "POST") return path === "/minimax/voice-clone" ? accepted("p-voice") : accepted("p-speak");
      return path.includes("p-voice") ? result("p-voice", "completed", []) : result("p-speak", "completed", ["https://out.example/s.mp3"]);
    });
    const r = runner();
    let answer: MediaAnswer = await r.plan("voice-clone", speech, DEFAULT, options);
    let lastCallMs = 0;
    for (let turn = 0; turn < 6 && (answer.state === "send" || answer.state === "running"); turn++) {
      const started = Date.now();
      const bounds = { deadlineAt: started + 600_000 };
      answer = answer.state === "send" ? await r.send(stored(answer.ticket), bounds) : await r.poll(stored(answer.ticket), bounds);
      lastCallMs = Date.now() - started;
    }
    const done = expectState(answer, "done");
    expect(lastCallMs).toBeLessThan(SIDE_REQUEST_MS + 5_000);
    expect(done.costs).toEqual([lookupOf("p-voice"), lookupOf("p-speak")]);
  }, 90_000);

  it("stops a billing read at the call's own deadline when that comes sooner, its cost pending", async () => {
    a.answer(({ method, path }) => (path === "/billings/search" ? "hang" : method === "POST" ? accepted("p1") : result("p1", "completed", ["https://out.example/v.mp4"])));
    const r = runner();
    const running = expectState(await submitVideo(r) as MediaAnswer, "running");
    const started = Date.now();
    const done = expectState(await r.poll(stored(running.ticket), { deadlineAt: started + 2_000 }), "done");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(done.costs).toEqual([lookupOf("p1")]);
  });

  it("stops a billing read when the caller stops, its cost pending", async () => {
    a.answer(({ method, path }) => (path === "/billings/search" ? "hang" : method === "POST" ? accepted("p1") : result("p1", "completed", ["https://out.example/v.mp4"])));
    const r = runner();
    const running = expectState(await submitVideo(r) as MediaAnswer, "running");
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => stop.abort(), 1_000);
    const done = expectState(await r.poll(stored(running.ticket), { deadlineAt: started + 600_000, signal: stop.signal }), "done");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(done.costs).toEqual([lookupOf("p1")]);
  });

  it("ends a last cost lookup within the side-request limit while the billing endpoint hangs, its cost missing", async () => {
    a.answer(() => "hang");
    const started = Date.now();
    const cost = await provider().cost.lookup({ upstream: "ws_a", predictionId: "p1" }, { lastAttempt: true });
    expect(Date.now() - started).toBeLessThan(SIDE_REQUEST_MS + 5_000);
    expect(cost.state).toBe("missing");
  }, 60_000);
});

describe("a run's billed predictions reach the caller once, however it ends (critical path)", () => {
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

describe("a run's billed answers on fal and SandBase reach the caller once, however it ends (critical path)", () => {
  const FAL_SUBMITS = ["accept", "unreadable", "cut", "busy", "locked", "noModel", "cut503", "cut429", "cut403Locked", "cut400"] as const;
  const FAL_STATUSES = ["inProgress", "completed", "completedWithError"] as const;
  const FAL_RESULTS = ["ok", "dataUri", "busyForAPoll", "refused"] as const;
  const FAL_BILLINGS = ["events", "none", "forbidden", "busy", "malformed"] as const;
  /** A refusal whose body breaks off, with and without an id header: billed by nobody. */
  const CUT_REFUSALS = ["cut503", "cut503Named", "cut429", "cut429Named", "cut402", "cut402Named", "cut400", "cut400Named"] as const;
  const SB_SUBMITS = ["accept", "finishNow", "finishNowDataUri", "finishNowNoId", "failedNow", "overLimitNamed", "overLimitUnnamed", "unreadable", "cutNamed", "cutUnnamed", "cutEmptyTaskId", "emptyId", "emptyHeader", "busy", "balance", "noModel", ...CUT_REFUSALS] as const;
  const SB_ASKS = ["running", "completed", "completedEmpty", "dataUri", "failed", "overLimit", "busy"] as const;
  const SB_COSTS = ["settled", "unsettled", "unknown", "busy", "malformed", "noCost"] as const;
  /** The caller's media limit here: a SandBase answer carrying a bigger inline file is over the read limit. */
  const MAX_MEDIA_BYTES = 2_000;
  const smallDataUri = `data:audio/mpeg;base64,${Buffer.from("ID3 tiny").toString("base64")}`;
  const bigDataUri = `data:audio/mpeg;base64,${Buffer.alloc(MAX_MEDIA_BYTES * 2, 7).toString("base64")}`;
  const song = { prompt: "a song", params: { song: "https://cdn.example/a.mp3" } };

  /**
   * fal (on fake a) with a reference upload before the song, and SandBase (on fake b) with the song alone.
   * @param falFirst - Whether fal has the lower weight.
   * @returns The raw configuration.
   */
  function resellers(falFirst: boolean): ProviderConfigInput {
    return {
      upstreams: {
        fal: { kind: "fal", base_url: a.url, billing_url: `${a.url}/v1`, key_env: "FAL_KEY" },
        // A completed run without outputs fails at the next poll, so the property reaches that ending too.
        sandbase: { kind: "sandbase", base_url: `${b.url}/v1`, key_env: "SANDBASE_API_KEY", empty_output_wait_ms: 1 },
      },
      media: {
        models: {
          song: {
            upstreams: [
              {
                upstream: "fal",
                weight: falFirst ? 1 : 2,
                model_id: "mureka/song",
                prompt_field: "prompt",
                params: { song: { field: "reference_id" } },
                extra_steps: [{ kind: "upload_reference", endpoint: "mureka/upload", at: "before", for_param: "song" }],
                output_field: "audio",
                pricing,
              },
              { upstream: "sandbase", weight: falFirst ? 2 : 1, model_id: "mureka/song", prompt_field: "prompt", params: { song: { field: "song_url" } }, pricing },
            ],
          },
        },
      },
    };
  }

  /**
   * The next answer of a script, or its default once the script is spent.
   * @param script - The script.
   * @param fallback - The default.
   * @returns The answer.
   */
  const draw = <T>(script: { list: readonly T[]; at: number }, fallback: T): T => script.list[script.at++] ?? fallback;

  it("property: whatever fal and SandBase answer to submits, questions and cost lookups", async () => {
    const scripts = fc.record({
      falFirst: fc.boolean(),
      falSubmit: fc.array(fc.constantFrom(...FAL_SUBMITS), { maxLength: 5 }),
      falStatus: fc.array(fc.constantFrom(...FAL_STATUSES), { maxLength: 5 }),
      falResult: fc.array(fc.constantFrom(...FAL_RESULTS), { maxLength: 4 }),
      falBilling: fc.array(fc.constantFrom(...FAL_BILLINGS), { maxLength: 3 }),
      sbSubmit: fc.array(fc.constantFrom(...SB_SUBMITS), { maxLength: 5 }),
      sbAsk: fc.array(fc.constantFrom(...SB_ASKS), { maxLength: 4 }),
      sbCost: fc.array(fc.constantFrom(...SB_COSTS), { maxLength: 3 }),
      // The turn at which the caller's deadline has passed or the caller stopped, if any.
      endAt: fc.option(fc.nat(8), { nil: undefined }),
      endBy: fc.constantFrom("deadline", "abort"),
    });
    await fc.assert(
      fc.asyncProperty(scripts, async (s) => {
        vi.spyOn(Math, "random").mockReturnValue(0);
        const at = <T>(list: readonly T[]): { list: readonly T[]; at: number } => ({ list, at: 0 });
        const falSubmit = at(s.falSubmit);
        const falStatus = at(s.falStatus);
        const falResult = at(s.falResult);
        const falBilling = at(s.falBilling);
        const sbSubmit = at(s.sbSubmit);
        const sbAsk = at(s.sbAsk);
        const sbCost = at(s.sbCost);
        // Every billed answer the fakes gave: an id, unique across both, whose number is also its billed dollars; or none.
        let n = 0;
        const billedAs: string[] = [];
        let anonymous = 0;
        const refusedBilling = new Set<string>();
        const falKinds = new Map<string, "upload" | "song">();
        let resultBusy = 0;
        const usdOf = (id: string): number => Number(id.slice(1));
        /**
         * Bill a new id on one of the fakes.
         * @param prefix - `r` for fal, `s` for SandBase.
         * @returns The id.
         */
        const bill = (prefix: string): string => {
          const id = `${prefix}${++n}`;
          billedAs.push(id);
          return id;
        };
        a.answer(({ method, path, query }): Reply | undefined => {
          if (path === "/v1/models/billing-events") {
            const id = new URLSearchParams(query).get("request_id") ?? "";
            const next = draw(falBilling, "events");
            if (next === "busy") return { status: 503, body: { detail: "busy" } };
            if (next === "malformed") return { status: 200, body: { billing_events: [{ request_id: id, cost_total: "a lot", quantity: 1 }], has_more: false } };
            if (next === "forbidden") {
              refusedBilling.add(id);
              return { status: 403, body: { error: { type: "authorization_error", message: "forbidden" } } };
            }
            return { status: 200, body: { billing_events: next === "none" ? [] : [{ request_id: id, cost_total: usdOf(id), quantity: 1 }], has_more: false } };
          }
          if (method === "POST") {
            const next = draw(falSubmit, "accept");
            if (next === "accept") {
              const id = bill("r");
              falKinds.set(id, path === "/mureka/upload" ? "upload" : "song");
              return { status: 200, body: { request_id: id, status_url: `${a.url}/q/requests/${id}/status`, response_url: `${a.url}/q/requests/${id}`, queue_position: 0 } };
            }
            if (next === "unreadable") {
              anonymous++;
              return { status: 200, raw: "<html>ok</html>", contentType: "text/html" };
            }
            if (next === "cut") {
              anonymous++;
              return { status: 200, raw: "{\"request_id\":\"r", contentType: "application/json", cut: true };
            }
            if (next === "busy") return { status: 503, body: { detail: "busy" } };
            if (next.startsWith("cut")) {
              const raw = next === "cut403Locked" ? "{\"detail\":\"User is locked. Reason: Exhausted bal" : "{\"detail\":\"bu";
              return { status: Number(next.slice(3, 6)), raw, contentType: "application/json", cut: true };
            }
            if (next === "locked") return { status: 403, body: { detail: "User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing." } };
            return { status: 404, body: { detail: 'Application "mureka" not found' } };
          }
          const asked = /^\/q\/requests\/([^/]+)(\/status)?$/.exec(path);
          if (asked === null) return undefined;
          const id = asked[1]!;
          if (asked[2] !== undefined) {
            const next = draw(falStatus, "completed");
            if (next === "inProgress") return { status: 202, body: { status: "IN_PROGRESS" } };
            return { status: 200, body: next === "completed" ? { status: "COMPLETED" } : { status: "COMPLETED", error: "content policy violation" } };
          }
          if (resultBusy > 0) {
            resultBusy--;
            return { status: 503, body: { detail: "busy" } };
          }
          const next = draw(falResult, "ok");
          if (next === "busyForAPoll") {
            // Every delivery of this poll's result read answers 503.
            resultBusy = 2;
            return { status: 503, body: { detail: "busy" } };
          }
          if (next === "refused") return { status: 422, body: { detail: [{ msg: "no media generated", type: "no_media_generated" }] } };
          if (falKinds.get(id) === "upload") return { status: 200, body: { id: `upload-${id}`, purpose: "reference" } };
          return { status: 200, body: { audio: { url: next === "dataUri" ? smallDataUri : `https://out.example/${id}.mp3` } } };
        });
        b.answer(({ method, path }): Reply | undefined => {
          if (method === "POST" && path === "/v1/run") {
            const next = draw(sbSubmit, "accept");
            const done = (url: string): { id?: string; status: string; outputs: { url: string }[] } => ({ status: "completed", outputs: [{ url }] });
            if (next === "accept") return { status: 202, body: { id: bill("s"), status: "pending" } };
            if (next === "finishNow" || next === "finishNowDataUri") {
              const id = bill("s");
              return { status: 200, body: { ...done(next === "finishNow" ? `https://out.example/${id}.mp3` : smallDataUri), id } };
            }
            if (next === "overLimitNamed") {
              const id = bill("s");
              return { status: 200, headers: { "x-task-id": id }, body: { ...done(bigDataUri), id } };
            }
            if (next === "failedNow") return { status: 200, body: { id: bill("s"), status: "failed", error: "boom" } };
            if (next === "cutNamed") return { status: 202, raw: `{"id":"${bill("s")}","sta`, contentType: "application/json", headers: { "x-request-id": `s${n}` }, cut: true };
            if (next === "emptyId") {
              anonymous++;
              return { status: 202, body: { id: "", status: "pending" } };
            }
            if (next === "emptyHeader") {
              anonymous++;
              return { status: 200, headers: { "x-task-id": "" }, body: done("https://out.example/empty-header.mp3") };
            }
            if (next === "cutEmptyTaskId") return { status: 202, raw: `{"id":"${bill("s")}","sta`, contentType: "application/json", headers: { "x-task-id": "", "x-request-id": `s${n}` }, cut: true };
            if (next === "cutUnnamed") {
              anonymous++;
              return { status: 202, raw: "{\"id\":\"s", contentType: "application/json", cut: true };
            }
            if (next === "finishNowNoId" || next === "overLimitUnnamed" || next === "unreadable") {
              anonymous++;
              if (next === "unreadable") return { status: 200, raw: "<html>ok</html>", contentType: "text/html" };
              return { status: 200, body: done(next === "finishNowNoId" ? "https://out.example/no-id.mp3" : bigDataUri) };
            }
            if (next === "busy") return { status: 503, body: { error: "busy" } };
            if ((CUT_REFUSALS as readonly string[]).includes(next)) {
              const headers = next.endsWith("Named") ? { "x-task-id": `refused${n}`, "x-request-id": `refused${n}` } : undefined;
              return { status: Number(next.slice(3, 6)), raw: "{\"error\":\"insufficient bal", contentType: "application/json", headers, cut: true };
            }
            if (next === "balance") return { status: 402, body: { error: "insufficient balance" } };
            return { status: 404, body: { error: "model not found: mureka/song" } };
          }
          const run = /^\/v1\/run\/([^/]+)$/.exec(path);
          if (run !== null) {
            const id = run[1]!;
            const next = draw(sbAsk, "completed");
            if (next === "busy") return { status: 503, body: { error: "busy" } };
            if (next === "completedEmpty") return { status: 200, body: { id, status: "completed" } };
            if (next === "running") return { status: 200, body: { id, status: "running" } };
            if (next === "failed") return { status: 200, body: { id, status: "failed", error: "boom" } };
            const url = next === "completed" ? `https://out.example/${id}.mp3` : next === "dataUri" ? smallDataUri : bigDataUri;
            return { status: 200, body: { id, status: "completed", outputs: [{ url }] } };
          }
          const cost = /^\/v1\/tasks\/([^/]+)\/cost$/.exec(path);
          if (cost === null) return undefined;
          const next = draw(sbCost, "settled");
          if (next === "busy") return { status: 503, body: { error: "busy" } };
          if (next === "malformed") return { status: 200, body: { id: cost[1], settled: true, currency: "USD", cost: "n/a" } };
          if (next === "noCost") return { status: 200, body: { id: cost[1], settled: true, currency: "USD" } };
          if (next === "unknown") return { status: 404, body: { error: "task not found" } };
          return { status: 200, body: { id: cost[1], settled: next === "settled", currency: "USD", cost: String(usdOf(cost[1]!)) } };
        });
        const keys: Record<string, string> = { FAL_KEY: "fal-key", SANDBASE_API_KEY: "sb-key" };
        const p = createProvider({ config: resellers(s.falFirst), keyOf: (name) => keys[name], llmMaxRetries: 0, cleanText: (t) => t });
        const r = createMediaRunner(p, { mediaLimits: { maxMediaBytes: MAX_MEDIA_BYTES }, pollIntervalMs: 0 });
        const reached: Cost[] = [];
        let answer: MediaAnswer = await r.plan("song", song, DEFAULT, options);
        let givenUp = false;
        for (let turn = 0; turn < 24 && (answer.state === "send" || answer.state === "running"); turn++) {
          const ticket = stored((answer as { ticket: MediaTicket }).ticket);
          const ended = turn === s.endAt;
          const bounds = !ended ? live() : s.endBy === "deadline" ? { deadlineAt: Date.now() - 1 } : { deadlineAt: Date.now() + 60_000, signal: AbortSignal.abort() };
          try {
            answer = answer.state === "running" ? await r.poll(ticket, bounds) : await r.send(ticket, bounds);
          } catch (error) {
            reached.push(...costsOf(error));
            if (error instanceof DeadlinePassed || error instanceof Aborted) {
              // The caller gives the run up: what the ticket still holds comes from abandon.
              reached.push(...r.abandon(ticket).costs);
              givenUp = true;
              break;
            }
            if (error instanceof NoAnswer) answer = await r.recover(ticket, live());
            else if (!(error instanceof SendNotAccepted)) throw error;
          }
          if (ended) break;
        }
        if (!givenUp) {
          if (answer.state === "done" || answer.state === "failed") reached.push(...answer.costs);
          else reached.push(...r.abandon(stored((answer as { ticket: MediaTicket }).ticket)).costs);
        }
        const identified: string[] = [];
        let missing = 0;
        for (const cost of reached) {
          if (cost.state === "missing") missing++;
          else if (cost.state === "pending") {
            identified.push(String(cost.lookup.predictionId));
            expect(cost.lookup.upstream).toBe(String(cost.lookup.predictionId).startsWith("r") ? "fal" : "sandbase");
          } else {
            expect(cost.source).toBe("billing");
            const id = billedAs.find((x) => usdOf(x) === cost.usd);
            expect(id).toBeDefined();
            identified.push(id!);
          }
        }
        expect(identified.sort()).toEqual(billedAs.filter((id) => !refusedBilling.has(id)).sort());
        expect(missing).toBe(anonymous + refusedBilling.size);
      }),
      { numRuns: 60 },
    );
  });

  it.each([
    ["fal", 503, false, true],
    ["fal", 429, false, true],
    ["fal", 400, false, false],
    ["sandbase", 503, false, true],
    ["sandbase", 503, true, true],
    ["sandbase", 429, false, true],
    ["sandbase", 429, true, true],
    ["sandbase", 402, false, true],
    ["sandbase", 402, true, true],
    ["sandbase", 400, false, false],
    ["sandbase", 400, true, false],
  ] as const)("a %s submit answered %i whose body breaks off (id header: %s) is that status, nothing billed; moves on: %s", async (first, status, named, moves) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const refuse = (): Reply => ({ status, raw: "{\"error\":\"insufficient bal", contentType: "application/json", headers: named ? { "x-task-id": "t1", "x-request-id": "t1" } : undefined, cut: true });
    (first === "fal" ? a : b).answer(({ method }) => (method === "POST" ? refuse() : undefined));
    const keys: Record<string, string> = { FAL_KEY: "fal-key", SANDBASE_API_KEY: "sb-key" };
    const p = createProvider({ config: resellers(first === "fal"), keyOf: (name) => keys[name], llmMaxRetries: 0, cleanText: (t) => t });
    const r = createMediaRunner(p, { mediaLimits: { maxMediaBytes: MAX_MEDIA_BYTES }, pollIntervalMs: 0 });
    const planned = expectState(await r.plan("song", song, DEFAULT, options), "send");
    const answer = await r.send(stored(planned.ticket), live());
    if (moves) expect(expectState(answer, "send").warnings.map((w) => w.code)).toContain("upstream_switched");
    else expect(expectState(answer, "failed").costs).toEqual([]);
  });
});

describe("a refusal whose body cannot be read is still its status", () => {
  const oversized = (status: number): ReturnType<typeof accepted> => ({ status, raw: "x".repeat(11 * 1024 * 1024), contentType: "text/plain" });

  it("a submit answered 503 with a body over the limit moves to the next upstream", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    a.answer(() => oversized(503));
    const moved = expectState(await submitVideo(runner()) as MediaAnswer, "send");
    expect(moved.warnings.map((w) => w.code)).toContain("upstream_switched");
  });

  it("a submit answered 400 with a body over the limit fails the run", async () => {
    a.answer(() => oversized(400));
    expectState(await submitVideo(runner()) as MediaAnswer, "failed");
  });

  it("a poll answered 503 with a body over the limit is still running", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    a.answer(({ method }) => (method === "POST" ? accepted("p1") : oversized(503)));
    const r = runner();
    const running = expectState(await submitVideo(r) as MediaAnswer, "running");
    expectState(await r.poll(stored(running.ticket), live()), "running");
  });
});

