// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MediaBinding, ProviderConfigInput } from "../../config/schema.js";
import { DeadlinePassed, NoUpstreamAvailable, SendNotAccepted, UpstreamRequestRejected, UpstreamTaskFailed } from "../../errors.js";
import { NoAnswer } from "../../http/errors.js";
import { createProvider } from "../../provider.js";
import type { Route } from "../../routing/route.js";
import { createMediaRunner, type MediaAnswer, type MediaClone, type MediaRunner, type MediaTicket } from "../runner.js";
import { accepted, billedIds, billing, fakeUpstream, finishedAtOnce, result, submits, type FakeUpstream } from "./fake-upstream.js";

const pricing = { kind: "formula", base_price: 0, formula: "", discount_rate: 100 };
const DEFAULT: Route = { mode: "default" };

/**
 * The video model of these cases, bound to both fake upstreams.
 * @returns Its bindings.
 */
function seedance(): MediaBinding[] {
  const binding = (upstream: string, weight: number): MediaBinding => ({
    upstream,
    weight,
    model_id: "bytedance/seedance",
    prompt_field: "prompt",
    params: { duration: { field: "duration" }, aspect_ratio: { field: "aspect_ratio", values: { "16:9": "landscape" } } },
    pricing,
  });
  return [binding("ws_a", 1), binding("ws_b", 2)];
}

/** A voice clone model: the clone, then speech in the cloned voice. */
const voiceClone: MediaBinding[] = [
  {
    upstream: "ws_a",
    weight: 1,
    model_id: "minimax/voice-clone",
    params: { audio: { field: "audio" } },
    reused_by: "audio",
    extra_steps: [{ kind: "speak", endpoint: "minimax/speech-2.8-hd", at: "after" }],
    pricing,
  },
];

let a: FakeUpstream;
let b: FakeUpstream;

beforeEach(async () => {
  a = await fakeUpstream();
  b = await fakeUpstream();
});

afterEach(async () => {
  await Promise.all([a.close(), b.close()]);
});

/**
 * The configuration of these cases: two WaveSpeed-kind upstreams on the fakes.
 * @returns The raw configuration.
 */
function config(): ProviderConfigInput {
  return {
    upstreams: {
      ws_a: { kind: "wavespeed", base_url: a.url, key_env: "WS_A_KEY" },
      ws_b: { kind: "wavespeed", base_url: b.url, key_env: "WS_B_KEY" },
    },
    media: { models: { seedance: { upstreams: seedance() }, "voice-clone": { upstreams: voiceClone } } },
  };
}

/**
 * A runner over the fakes.
 * @param keys - The environment the runner reads keys from.
 * @returns The runner.
 */
function runner(keys: Record<string, string> = { WS_A_KEY: "key-a", WS_B_KEY: "key-b" }): MediaRunner {
  const provider = createProvider({ config: config(), keyOf: (name) => keys[name], llmMaxRetries: 2, cleanText: (t) => t });
  return createMediaRunner(provider, { mediaLimits: { maxMediaBytes: 1_000_000 } });
}

/**
 * What the caller's database gives back: the ticket through JSON.
 * @param ticket - The ticket as provider answered it.
 * @returns The ticket as the caller reads it back.
 */
const stored = (ticket: MediaTicket): MediaTicket => JSON.parse(JSON.stringify(ticket)) as MediaTicket;

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

const live = (): { deadlineAt: number } => ({ deadlineAt: Date.now() + 60_000 });
const options = (clones: MediaClone[] = []): { idempotencyKey: string; sourceKeys: Record<string, string>; clones: MediaClone[] } => ({
  idempotencyKey: "task-1",
  sourceKeys: { "https://cdn.example/a.mp3": "sha-a" },
  clones,
});
const video = { prompt: "a fox in snow", params: { duration: 5, aspect_ratio: "16:9" } };

describe("plan", () => {
  it("sends nothing and answers a send ticket for the model's own call", () => {
    const answer = expectState(runner().plan("seedance", video, DEFAULT, options()), "send");
    expect(answer.step.kind).toBe("generate");
    expect(a.seen).toHaveLength(0);
    expect(b.seen).toHaveLength(0);
  });

  it("places the run on the lowest weight that is configured", async () => {
    const r = runner({ WS_B_KEY: "key-b" });
    a.answer(() => accepted("p1"));
    b.answer(() => accepted("p1"));
    const planned = expectState(r.plan("seedance", video, DEFAULT, options()), "send");
    await r.send(stored(planned.ticket), live());
    expect(submits(a.seen)).toHaveLength(0);
    expect(submits(b.seen)).toHaveLength(1);
  });

  it("answers failed with NoUpstreamAvailable naming each missing key when nothing is configured", () => {
    const answer = expectState(runner({}).plan("seedance", video, DEFAULT, options()), "failed");
    expect(answer.reason).toBeInstanceOf(NoUpstreamAvailable);
    expect((answer.reason as NoUpstreamAvailable).reasons).toEqual([
      { upstream: "ws_a", kind: "missing_key", envVar: "WS_A_KEY" },
      { upstream: "ws_b", kind: "missing_key", envVar: "WS_B_KEY" },
    ]);
    expect(answer.costs).toEqual([]);
  });

  it("throws UpstreamRequestRejected for an upstream the model is not bound to", () => {
    expect(() => runner().plan("voice-clone", video, { mode: "upstream", upstream: "ws_b" }, options())).toThrow(UpstreamRequestRejected);
  });
});

describe("send", () => {
  it("submits our params under the binding's field names with the upstream's key, and answers running", async () => {
    a.answer(() => accepted("p1"));
    const r = runner();
    const planned = expectState(r.plan("seedance", video, DEFAULT, options()), "send");
    const answer = expectState(await r.send(stored(planned.ticket), live()), "running");
    expect(answer.askAgainAt).toBeGreaterThan(Date.now() - 1_000);
    const [submit] = submits(a.seen);
    expect(submit?.path).toBe("/bytedance/seedance");
    expect(submit?.body).toEqual({ prompt: "a fox in snow", duration: 5, aspect_ratio: "landscape" });
    expect(submit?.authorization).toBe("Bearer key-a");
  });

  it("answers done at once when the submit already carries the outputs, with the billed cost", async () => {
    a.answer(({ method, path }) => {
      if (method === "POST" && path === "/billings/search") return billing([{ type: "deduct", price: 0.2 }]);
      return finishedAtOnce("p1", ["https://out.example/v.mp4"]);
    });
    const r = runner();
    const planned = expectState(r.plan("seedance", video, DEFAULT, options()), "send");
    const answer = expectState(await r.send(stored(planned.ticket), live()), "done");
    expect(answer.outputs).toEqual([{ kind: "url", url: "https://out.example/v.mp4" }]);
    expect(answer.costs).toEqual([{ state: "known", usd: 0.2, source: "billing" }]);
    expect(answer.servedBy).toBe("ws_a");
  });

  it.each([
    ["a 503", (): Promise<void> => Promise.resolve(a.answer(() => ({ status: 503, body: {} })))],
    ["a 429", (): Promise<void> => Promise.resolve(a.answer(() => ({ status: 429, body: {} })))],
    ["a refused connection", (): Promise<void> => a.close()],
  ])("moves to the next upstream after %s before any step was accepted, without sending there yet", async (_name, fail) => {
    await fail();
    b.answer(() => accepted("p1"));
    const r = runner();
    const planned = expectState(r.plan("seedance", video, DEFAULT, options()), "send");
    const moved = expectState(await r.send(stored(planned.ticket), live()), "send");
    expect(moved.warnings.map((w) => w.code)).toContain("upstream_switched");
    expect(b.seen).toHaveLength(0);
    await r.send(stored(moved.ticket), live());
    expect(submits(b.seen)).toHaveLength(1);
  });

  it("throws SendNotAccepted on a 503 when there is no next upstream", async () => {
    a.answer(() => ({ status: 503, body: {} }));
    const r = runner({ WS_A_KEY: "key-a" });
    const planned = expectState(r.plan("seedance", video, DEFAULT, options()), "send");
    await expect(r.send(stored(planned.ticket), live())).rejects.toBeInstanceOf(SendNotAccepted);
  });

  it("throws SendNotAccepted on a 503 in upstream mode, never trying another upstream", async () => {
    a.answer(() => ({ status: 503, body: {} }));
    const r = runner();
    const planned = expectState(r.plan("seedance", video, { mode: "upstream", upstream: "ws_a" }, options()), "send");
    await expect(r.send(stored(planned.ticket), live())).rejects.toBeInstanceOf(SendNotAccepted);
    expect(b.seen).toHaveLength(0);
  });

  it("answers failed with UpstreamRequestRejected on a 400, never trying another upstream", async () => {
    a.answer(() => ({ status: 400, body: { message: "duration must be 5 or 10" } }));
    const r = runner();
    const planned = expectState(r.plan("seedance", video, DEFAULT, options()), "send");
    const answer = expectState(await r.send(stored(planned.ticket), live()), "failed");
    expect(answer.reason).toBeInstanceOf(UpstreamRequestRejected);
    expect(b.seen).toHaveLength(0);
  });

  it("throws NoAnswer when the connection drops after the request arrived", async () => {
    a.answer(() => "reset");
    const r = runner();
    const planned = expectState(r.plan("seedance", video, DEFAULT, options()), "send");
    await expect(r.send(stored(planned.ticket), live())).rejects.toBeInstanceOf(NoAnswer);
    expect(b.seen).toHaveLength(0);
  });

  it("sends nothing once the deadline has passed", async () => {
    const r = runner();
    const planned = expectState(r.plan("seedance", video, DEFAULT, options()), "send");
    await expect(r.send(stored(planned.ticket), { deadlineAt: Date.now() - 1 })).rejects.toBeInstanceOf(DeadlinePassed);
    expect(a.seen).toHaveLength(0);
  });

  it("refuses a ticket that is not waiting to be sent", async () => {
    a.answer(() => accepted("p1"));
    const r = runner();
    const planned = expectState(r.plan("seedance", video, DEFAULT, options()), "send");
    const running = expectState(await r.send(stored(planned.ticket), live()), "running");
    await expect(r.send(stored(running.ticket), live())).rejects.toThrow();
    expect(submits(a.seen)).toHaveLength(1);
  });
});

describe("poll", () => {
  /**
   * Plan and send the video run on ws_a.
   * @param r - The runner.
   * @returns The running ticket.
   */
  async function sent(r: MediaRunner): Promise<MediaTicket> {
    const planned = expectState(r.plan("seedance", video, DEFAULT, options()), "send");
    return stored(expectState(await r.send(stored(planned.ticket), live()), "running").ticket);
  }

  it("answers running while the prediction is still going, asking once", async () => {
    const r = runner();
    a.answer(({ method }) => (method === "POST" ? accepted("p1") : result("p1", "processing")));
    const answer = expectState(await r.poll(await sent(r), live()), "running");
    expect(answer.askAgainAt).toBeGreaterThan(Date.now() - 1_000);
    expect(a.seen.filter((s) => s.method === "GET").map((s) => s.path)).toEqual(["/predictions/p1/result"]);
  });

  it("answers done with the outputs and the billed cost, deducts less refunds", async () => {
    const r = runner();
    a.answer(({ method, path }) => {
      if (path === "/billings/search") return billing([{ type: "deduct", price: 0.2 }, { type: "refund", price: 0.05 }]);
      return method === "POST" ? accepted("p1") : result("p1", "completed", ["https://out.example/v.mp4"]);
    });
    const answer = expectState(await r.poll(await sent(r), live()), "done");
    expect(answer.outputs).toEqual([{ kind: "url", url: "https://out.example/v.mp4" }]);
    expect(answer.costs).toHaveLength(1);
    expect(answer.costs[0]).toMatchObject({ state: "known", source: "billing" });
    expect((answer.costs[0] as { usd: number }).usd).toBeCloseTo(0.15, 12);
    expect(answer.servedBy).toBe("ws_a");
    expect(billedIds(a.seen)).toEqual(["p1"]);
    expect(submits(a.seen)).toHaveLength(1);
  });

  it("answers a pending cost when billing has no line yet", async () => {
    const r = runner();
    a.answer(({ method, path }) => {
      if (path === "/billings/search") return billing([]);
      return method === "POST" ? accepted("p1") : result("p1", "completed", ["https://out.example/v.mp4"]);
    });
    const answer = expectState(await r.poll(await sent(r), live()), "done");
    expect(answer.costs).toHaveLength(1);
    expect(answer.costs[0]).toMatchObject({ state: "pending", lookup: { upstream: "ws_a" } });
  });

  it("answers failed with UpstreamTaskFailed carrying the upstream's words", async () => {
    const r = runner();
    a.answer(({ method, path }) => {
      if (path === "/billings/search") return billing([]);
      return method === "POST" ? accepted("p1") : result("p1", "failed", [], "content policy");
    });
    const answer = expectState(await r.poll(await sent(r), live()), "failed");
    expect(answer.reason).toBeInstanceOf(UpstreamTaskFailed);
    expect((answer.reason as UpstreamTaskFailed).upstreamError).toBe("content policy");
  });

  it("asks nothing after the deadline unless it is the final ask", async () => {
    const r = runner();
    a.answer(({ method, path }) => {
      if (path === "/billings/search") return billing([{ type: "deduct", price: 0.2 }]);
      return method === "POST" ? accepted("p1") : result("p1", "completed", ["https://out.example/v.mp4"]);
    });
    const ticket = await sent(r);
    const before = a.seen.length;
    await expect(r.poll(ticket, { deadlineAt: Date.now() - 1 })).rejects.toBeInstanceOf(DeadlinePassed);
    expect(a.seen).toHaveLength(before);
    const answer = expectState(await r.poll(ticket, { deadlineAt: Date.now() - 1, finalAsk: true }), "done");
    expect(answer.costs[0]).toMatchObject({ state: "known", usd: 0.2 });
  });
});

describe("a run of several steps", () => {
  const speech = { prompt: "hello there", params: { audio: "https://cdn.example/a.mp3" } };

  it("hands each next step back as a send ticket; poll itself never sends", async () => {
    const r = runner();
    a.answer(({ method, path }) => {
      if (path === "/billings/search") return billing([{ type: "deduct", price: 0.1 }]);
      if (method === "POST" && path === "/minimax/voice-clone") return accepted("p-voice");
      if (method === "POST" && path === "/minimax/speech-2.8-hd") return accepted("p-speak");
      if (path === "/predictions/p-voice/result") return result("p-voice", "completed", []);
      return result("p-speak", "completed", ["https://out.example/s.mp3"]);
    });
    const versions: number[] = [];
    const keep = (answer: MediaAnswer): MediaAnswer => {
      if ("ticket" in answer) versions.push(answer.ticket.version);
      return answer;
    };

    const planned = expectState(keep(r.plan("voice-clone", speech, DEFAULT, options())), "send");
    expect(planned.step.kind).toBe("voice");
    const cloning = expectState(keep(await r.send(stored(planned.ticket), live())), "running");
    const clone = submits(a.seen)[0]?.body as Record<string, unknown>;
    expect(clone.audio).toBe("https://cdn.example/a.mp3");
    expect(String(clone.custom_voice_id)).toMatch(/^Breatic/);

    const next = expectState(keep(await r.poll(stored(cloning.ticket), live())), "send");
    expect(next.step.kind).toBe("speak");
    expect(submits(a.seen)).toHaveLength(1);
    expect(next.clones).toEqual([{ upstream: "ws_a", kind: "voice", sourceKey: "sha-a", upstreamId: clone.custom_voice_id }]);

    const speaking = expectState(keep(await r.send(stored(next.ticket), live())), "running");
    expect(submits(a.seen)[1]?.body).toEqual({ text: "hello there", voice_id: clone.custom_voice_id });

    const done = expectState(await r.poll(stored(speaking.ticket), live()), "done");
    expect(done.outputs).toEqual([{ kind: "url", url: "https://out.example/s.mp3" }]);
    expect(billedIds(a.seen).sort()).toEqual(["p-speak", "p-voice"]);
    expect(done.costs).toHaveLength(2);
    expect(versions).toEqual([...versions].sort((x, y) => x - y));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("uses this upstream's cached clone and skips the clone step", async () => {
    const r = runner();
    a.answer(({ method }) => (method === "POST" ? accepted("p-speak") : result("p-speak", "processing")));
    const cached: MediaClone[] = [
      { upstream: "ws_b", kind: "voice", sourceKey: "sha-a", upstreamId: "voice-on-b" },
      { upstream: "ws_a", kind: "voice", sourceKey: "sha-a", upstreamId: "voice-on-a" },
    ];
    const planned = expectState(r.plan("voice-clone", speech, DEFAULT, options(cached)), "send");
    expect(planned.step.kind).toBe("speak");
    await r.send(stored(planned.ticket), live());
    expect(submits(a.seen).map((s) => s.body)).toEqual([{ text: "hello there", voice_id: "voice-on-a" }]);
  });

  it("answers the cached clone the upstream says is gone as retired when the run fails", async () => {
    const r = runner();
    a.answer(({ method, path }) => {
      if (path === "/billings/search") return billing([]);
      return method === "POST" ? accepted("p-speak") : result("p-speak", "failed", [], "Voice ID does not exist");
    });
    const cached: MediaClone[] = [{ upstream: "ws_a", kind: "voice", sourceKey: "sha-a", upstreamId: "voice-on-a" }];
    const planned = expectState(r.plan("voice-clone", speech, DEFAULT, options(cached)), "send");
    const speaking = expectState(await r.send(stored(planned.ticket), live()), "running");
    const failed = expectState(await r.poll(stored(speaking.ticket), live()), "failed");
    expect(failed.reason).toBeInstanceOf(UpstreamTaskFailed);
    expect(failed.retiredClones).toEqual(cached);
  });
});

describe("recover", () => {
  it("answers the same send ticket with a duplicate-cost warning for an upstream that cannot be asked, sending nothing", async () => {
    const r = runner();
    const planned = expectState(r.plan("seedance", video, DEFAULT, options()), "send");
    const answer = expectState(await r.recover(stored(planned.ticket), live()), "send");
    expect(answer.step.kind).toBe("generate");
    expect(answer.warnings.map((w) => w.code)).toContain("potential_duplicate_cost");
    expect(a.seen).toHaveLength(0);
  });
});

describe("ticketFromLegacy", () => {
  it("continues a submitted step by its stored prediction id without submitting again", async () => {
    const r = runner();
    a.answer(() => result("p-old", "processing"));
    const legacy = {
      steps: [{ position: 0, kind: "generate" as const, endpoint: "bytedance/seedance", itemIndex: null, status: "submitted" as const, predictionId: "p-old", output: {}, inlineCostUsd: 0 }],
    };
    const answer = expectState(r.ticketFromLegacy("seedance", video, DEFAULT, options(), legacy), "running");
    await r.poll(stored(answer.ticket), live());
    expect(a.seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /predictions/p-old/result"]);
  });

  it("plans a step still pending from the run's input and what the done steps answered", async () => {
    const r = runner();
    a.answer(({ method, path }) => {
      if (path === "/billings/search") return billing([{ type: "deduct", price: 0.1 }]);
      return method === "POST" ? accepted("p-speak") : result("p-speak", "completed", ["https://out.example/s.mp3"]);
    });
    const legacy = {
      steps: [
        { position: 0, kind: "voice" as const, endpoint: "minimax/voice-clone", itemIndex: null, status: "done" as const, predictionId: "p-voice", output: { voiceId: "BreaticOld", prediction: "p-voice" }, inlineCostUsd: 0 },
        { position: 1, kind: "speak" as const, endpoint: "minimax/speech-2.8-hd", itemIndex: null, status: "pending" as const, predictionId: null, output: {}, inlineCostUsd: 0 },
      ],
    };
    const speech = { prompt: "hello there", params: { audio: "https://cdn.example/a.mp3" } };
    const next = expectState(r.ticketFromLegacy("voice-clone", speech, DEFAULT, options(), legacy), "send");
    expect(next.step.kind).toBe("speak");
    const speaking = expectState(await r.send(stored(next.ticket), live()), "running");
    expect(submits(a.seen).map((s) => s.body)).toEqual([{ text: "hello there", voice_id: "BreaticOld" }]);
    const done = expectState(await r.poll(stored(speaking.ticket), live()), "done");
    expect(billedIds(a.seen).sort()).toEqual(["p-speak", "p-voice"]);
    expect(done.costs).toHaveLength(2);
  });
});
