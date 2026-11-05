// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfigInput } from "../../../config/schema.js";
import { costsOf, NoUpstreamAvailable, UpstreamRequestRejected, UpstreamTaskFailed } from "../../../errors.js";
import { NoAnswer } from "../../../http/errors.js";
import { createProvider } from "../../../provider.js";
import { createMediaRunner, type MediaAnswer, type MediaRunner, type MediaTicket } from "../../runner.js";
import { accepted, fakeUpstream, submits, type FakeUpstream, type Reply } from "../../__tests__/fake-upstream.js";

const pricing = { kind: "formula", base_price: 100_000, formula: "", discount_rate: 100 };
/** The largest file the caller takes in these cases; an answer carrying a bigger inline file is over the read limit. */
const MAX_MEDIA_BYTES = 2_000;

let sb: FakeUpstream;
let ws: FakeUpstream;

beforeEach(async () => {
  sb = await fakeUpstream();
  ws = await fakeUpstream();
});

afterEach(async () => {
  await Promise.all([sb.close(), ws.close()]);
});

/** How long these cases let a completed run without outputs wait for them. */
const EMPTY_OUTPUT_WAIT_MS = 60_000;

/**
 * The configuration: SandBase first, a WaveSpeed-kind fake second.
 * @param extra - More models.
 * @returns The raw configuration.
 */
function config(extra: ProviderConfigInput["media"]["models"] = {}): ProviderConfigInput {
  const bindings = [
    { upstream: "sandbase", weight: 1, model_id: "bfl/flux-2/flash", prompt_field: "prompt", params: { aspect_ratio: { field: "aspect_ratio" } }, fixed: { mode: "async" }, pricing },
    { upstream: "ws", weight: 2, model_id: "ws/flux", prompt_field: "prompt", params: { aspect_ratio: { field: "aspect_ratio" } }, pricing },
  ];
  return {
    upstreams: {
      sandbase: { kind: "sandbase", base_url: `${sb.url}/v1`, key_env: "SANDBASE_API_KEY", empty_output_wait_ms: EMPTY_OUTPUT_WAIT_MS },
      ws: { kind: "wavespeed", base_url: ws.url, key_env: "WS_KEY" },
    },
    media: {
      models: {
        flux: { upstreams: bindings },
        "flux-only": { upstreams: [bindings[0]!] },
        ...extra,
      },
    },
  };
}

/**
 * A runner over the fakes.
 * @param keys - The environment.
 * @param extra - More models.
 * @returns The runner and its provider.
 */
function runner(keys: Record<string, string> = { SANDBASE_API_KEY: "sb-key", WS_KEY: "ws-key" }, extra: ProviderConfigInput["media"]["models"] = {}): { run: MediaRunner; provider: ReturnType<typeof createProvider> } {
  const provider = createProvider({ config: config(extra), keyOf: (name) => keys[name], llmMaxRetries: 0, cleanText: (t) => t });
  return { run: createMediaRunner(provider, { mediaLimits: { maxMediaBytes: MAX_MEDIA_BYTES }, pollIntervalMs: 0 }), provider };
}

const stored = (ticket: MediaTicket): MediaTicket => JSON.parse(JSON.stringify(ticket)) as MediaTicket;
const live = (): { deadlineAt: number } => ({ deadlineAt: Date.now() + 60_000 });
const options = { idempotencyKey: "task-1", sourceKeys: {}, clones: [], durations: {} };

/**
 * Narrow an answer to one state.
 * @param answer - The answer.
 * @param state - The state expected.
 * @returns The answer, narrowed.
 */
function expectState<S extends MediaAnswer["state"]>(answer: MediaAnswer, state: S): Extract<MediaAnswer, { state: S }> {
  expect(answer.state).toBe(state);
  return answer as Extract<MediaAnswer, { state: S }>;
}

/**
 * Plan and send a run of a model.
 * @param r - The runner.
 * @param model - The model.
 * @returns The send's answer.
 */
async function sent(r: MediaRunner, model = "flux"): Promise<MediaAnswer> {
  const planned = expectState(await r.plan(model, { prompt: "a fox", params: { aspect_ratio: "16:9" } }, { mode: "default" }, options), "send");
  return r.send(stored(planned.ticket), live());
}

/**
 * SandBase's task cost answer.
 * @param settled - Whether the cost is final.
 * @param cost - The cost in USD, as SandBase writes it.
 * @returns The reply.
 */
const taskCost = (settled: boolean, cost: string): Reply => ({ status: 200, body: { id: "r1", status: "completed", settled, currency: "USD", cost, estimated_cost: cost } });

/** A PNG's bytes as a data URI, longer than the caller's media limit once base64-encoded. */
const bigDataUri = `data:image/png;base64,${Buffer.alloc(MAX_MEDIA_BYTES * 2, 7).toString("base64")}`;

describe("SandBase runs", () => {
  it("submits the flat body with Bearer auth and the binding's mode, then finishes on the completed run's outputs and its settled cost", async () => {
    const { run } = runner();
    sb.answer(({ method, path }) => {
      if (method === "POST" && path === "/v1/run") return { status: 202, body: { id: "r1", status: "pending", model: "bfl/flux-2/flash" } };
      if (path === "/v1/run/r1") return { status: 200, body: { id: "r1", status: "completed", outputs: [{ content_type: "image/png", url: "https://media.example/r1/0.png" }] } };
      if (path === "/v1/tasks/r1/cost") return taskCost(true, "0.025000");
      return undefined;
    });
    const running = expectState(await sent(run), "running");
    const submit = submits(sb.seen)[0]!;
    expect(submit.authorization).toBe("Bearer sb-key");
    expect(submit.body).toEqual({ model: "bfl/flux-2/flash", prompt: "a fox", aspect_ratio: "16:9", mode: "async" });
    const done = expectState(await run.poll(stored(running.ticket), live()), "done");
    expect(done.outputs).toEqual([{ kind: "url", url: "https://media.example/r1/0.png" }]);
    expect(done.costs).toEqual([{ state: "known", usd: 0.025, source: "billing" }]);
  });

  it("finishes at once when the submit answers a completed run", async () => {
    const { run } = runner();
    sb.answer(({ method, path }) => {
      if (method === "POST" && path === "/v1/run") return { status: 200, body: { id: "r2", status: "completed", outputs: [{ url: "https://media.example/r2.mp3" }] } };
      if (path === "/v1/tasks/r2/cost") return taskCost(true, "0.010000");
      return undefined;
    });
    const done = expectState(await sent(run), "done");
    expect(done.outputs).toEqual([{ kind: "url", url: "https://media.example/r2.mp3" }]);
  });

  it("keeps running while pending or running", async () => {
    const { run } = runner();
    let asks = 0;
    sb.answer(({ method, path }) => {
      if (method === "POST" && path === "/v1/run") return { status: 202, body: { id: "r3", status: "pending" } };
      if (path === "/v1/run/r3") return { status: 200, body: { id: "r3", status: ["pending", "running"][asks++] ?? "running" } };
      return undefined;
    });
    let answer = expectState(await sent(run), "running");
    for (let i = 0; i < 3; i++) answer = expectState(await run.poll(stored(answer.ticket), live()), "running");
  });

  describe("a completed run that answers no outputs", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * Answer a completed run with no outputs until told otherwise, then with one.
     * @param outputs - Whether the run answers its output now.
     * @returns Nothing.
     */
    function completedRun(outputs: () => boolean): void {
      sb.answer(({ method, path }) => {
        if (method === "POST" && path === "/v1/run") return { status: 202, body: { id: "r9", status: "pending" } };
        if (path === "/v1/run/r9") return { status: 200, body: { id: "r9", status: "completed", ...(outputs() ? { outputs: [{ url: "https://media.example/r9.png" }] } : {}) } };
        if (path === "/v1/tasks/r9/cost") return taskCost(true, "0.020000");
        return undefined;
      });
    }

    it("keeps running within the configured wait, and finishes once the output arrives", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { run } = runner();
      let ready = false;
      completedRun(() => ready);
      let answer = expectState(await sent(run), "running");
      answer = expectState(await run.poll(stored(answer.ticket), live()), "running");
      vi.setSystemTime(Date.now() + EMPTY_OUTPUT_WAIT_MS - 1_000);
      answer = expectState(await run.poll(stored(answer.ticket), live()), "running");
      ready = true;
      const done = expectState(await run.poll(stored(answer.ticket), live()), "done");
      expect(done.outputs).toEqual([{ kind: "url", url: "https://media.example/r9.png" }]);
    });

    it("hands back a new ticket version only when it first sees the run so", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { run } = runner();
      completedRun(() => false);
      const sentAnswer = expectState(await sent(run), "running");
      const first = expectState(await run.poll(stored(sentAnswer.ticket), live()), "running");
      vi.setSystemTime(Date.now() + 1_000);
      const second = expectState(await run.poll(stored(first.ticket), live()), "running");
      expect(second.ticket.version).toBe(first.ticket.version);
    });

    it("fails the run, leaving its cost to look up, once the wait has passed since it first answered so", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { run } = runner();
      completedRun(() => false);
      let answer = expectState(await sent(run), "running");
      answer = expectState(await run.poll(stored(answer.ticket), live()), "running");
      vi.setSystemTime(Date.now() + EMPTY_OUTPUT_WAIT_MS + 1_000);
      const failed = expectState(await run.poll(stored(answer.ticket), live()), "failed");
      expect(failed.reason).toBeInstanceOf(UpstreamTaskFailed);
      expect((failed.reason as UpstreamTaskFailed).upstreamError).toMatch(/no output/i);
      expect(failed.costs).toEqual([{ state: "pending", lookup: { upstream: "sandbase", predictionId: "r9" } }]);
    });
  });

  it("asks again, with a warning, when a run's status answers 503", async () => {
    const { run } = runner();
    let asks = 0;
    sb.answer(({ method, path }) => {
      if (method === "POST" && path === "/v1/run") return { status: 202, body: { id: "r3b", status: "pending" } };
      if (path === "/v1/run/r3b") return ++asks <= 3 ? { status: 503, body: { error: "busy" } } : { status: 200, body: { id: "r3b", status: "completed", outputs: [{ url: "https://media.example/r3b.png" }] } };
      if (path === "/v1/tasks/r3b/cost") return taskCost(true, "0.020000");
      return undefined;
    });
    const running = expectState(await sent(run), "running");
    const again = expectState(await run.poll(stored(running.ticket), live()), "running");
    expect(again.warnings.map((w) => w.code)).toContain("poll_request_failed");
    expectState(await run.poll(stored(again.ticket), live()), "done");
  });

  describe("a submit answered 2xx whose body is cut", () => {
    it("is followed under the id its response header names, without a second submit, and billed under it", async () => {
      const { run } = runner();
      sb.answer(({ method, path }) => {
        if (method === "POST" && path === "/v1/run") return { status: 202, raw: "{\"id\":\"s9\",\"sta", contentType: "application/json", headers: { "x-request-id": "s9" }, cut: true };
        if (path === "/v1/run/s9") return { status: 200, body: { id: "s9", status: "completed", outputs: [{ url: "https://media.example/s9.png" }] } };
        if (path === "/v1/tasks/s9/cost") return { status: 200, body: { id: "s9", status: "completed", settled: true, currency: "USD", cost: "0.030000", estimated_cost: "0.030000" } };
        return undefined;
      });
      const running = expectState(await sent(run), "running");
      const done = expectState(await run.poll(stored(running.ticket), live()), "done");
      expect(done.costs).toEqual([{ state: "known", usd: 0.03, source: "billing" }]);
      expect(submits(sb.seen)).toHaveLength(1);
    });

    it("throws NoAnswer carrying one missing cost when no response header names the run", async () => {
      const { run } = runner();
      sb.answer(({ method, path }) => (method === "POST" && path === "/v1/run" ? { status: 202, raw: "{\"id\":\"s1", contentType: "application/json", cut: true } : undefined));
      const planned = expectState(await run.plan("flux", { prompt: "a fox", params: { aspect_ratio: "16:9" } }, { mode: "default" }, options), "send");
      const error = await run.send(stored(planned.ticket), live()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NoAnswer);
      expect(costsOf(error)).toEqual([expect.objectContaining({ state: "missing" })]);
    });
  });

  it("names the endpoint as the model whatever field the body carries", async () => {
    const binding = { upstream: "sandbase", weight: 1, model_id: "bfl/flux-2/flash", prompt_field: "prompt", fixed: { mode: "async", model: "someone/else" }, pricing };
    const { run } = runner(undefined, { "model-field": { upstreams: [binding] } });
    sb.answer(({ method }) => (method === "POST" ? { status: 202, body: { id: "r8", status: "pending" } } : { status: 200, body: { id: "r8", status: "running" } }));
    expectState(await sent(run, "model-field"), "running");
    expect((submits(sb.seen)[0]!.body as { model: string }).model).toBe("bfl/flux-2/flash");
  });

  it("fails the run on a failed or timed-out run, with SandBase's words", async () => {
    for (const status of ["failed", "timeout"]) {
      const { run } = runner();
      sb.answer(({ method, path }) => {
        if (method === "POST" && path === "/v1/run") return { status: 202, body: { id: "r4", status: "pending" } };
        if (path === "/v1/run/r4") return { status: 200, body: { id: "r4", status, error: `the run ${status}` } };
        if (path === "/v1/tasks/r4/cost") return taskCost(true, "0");
        return undefined;
      });
      const running = expectState(await sent(run), "running");
      const failed = expectState(await run.poll(stored(running.ticket), live()), "failed");
      expect(failed.reason).toBeInstanceOf(UpstreamTaskFailed);
      expect((failed.reason as UpstreamTaskFailed).upstreamError).toContain(`the run ${status}`);
    }
  });

  it("delivers a data URI output as bytes", async () => {
    const { run } = runner();
    const png = Buffer.from([137, 80, 78, 71]);
    sb.answer(({ method, path }) => {
      if (method === "POST" && path === "/v1/run") return { status: 202, body: { id: "r5", status: "pending" } };
      if (path === "/v1/run/r5") return { status: 200, body: { id: "r5", status: "completed", outputs: [{ url: `data:image/png;base64,${png.toString("base64")}` }] } };
      if (path === "/v1/tasks/r5/cost") return taskCost(true, "0.02");
      return undefined;
    });
    const running = expectState(await sent(run), "running");
    const done = expectState(await run.poll(stored(running.ticket), live()), "done");
    expect(done.outputs).toEqual([{ kind: "bytes", bytes: new Uint8Array(png), contentType: "image/png" }]);
    expect(JSON.stringify(running.ticket)).not.toContain("data:image");
  });

  it("delivers a percent-encoded data URI output byte for byte", async () => {
    const { run } = runner();
    sb.answer(({ method, path }) => {
      if (method === "POST" && path === "/v1/run") return { status: 202, body: { id: "r7", status: "pending" } };
      if (path === "/v1/run/r7") return { status: 200, body: { id: "r7", status: "completed", outputs: [{ url: "data:image/jpeg,%FF%D8%FF%E0A" }] } };
      if (path === "/v1/tasks/r7/cost") return taskCost(true, "0.02");
      return undefined;
    });
    const running = expectState(await sent(run), "running");
    const done = expectState(await run.poll(stored(running.ticket), live()), "done");
    expect(done.outputs).toEqual([{ kind: "bytes", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x41]), contentType: "image/jpeg" }]);
  });

  it("fails the run with the cost still looked up when a run's answer is over the read limit", async () => {
    const { run } = runner();
    sb.answer(({ method, path }) => {
      if (method === "POST" && path === "/v1/run") return { status: 202, body: { id: "r6", status: "pending" } };
      if (path === "/v1/run/r6") return { status: 200, body: { id: "r6", status: "completed", outputs: [{ url: bigDataUri }] } };
      return undefined;
    });
    const running = expectState(await sent(run), "running");
    const failed = expectState(await run.poll(stored(running.ticket), live()), "failed");
    expect(failed.reason.message).toContain("media limit");
    expect(failed.costs).toEqual([{ state: "pending", lookup: { upstream: "sandbase", predictionId: "r6" } }]);
  });

  it("fails the run with the cost looked up by the response header when a submit's answer is over the read limit", async () => {
    const { run } = runner();
    sb.answer(({ method, path }) => {
      if (method === "POST" && path === "/v1/run") return { status: 200, headers: { "x-task-id": "r7", "x-request-id": "r7" }, body: { id: "r7", status: "completed", outputs: [{ url: bigDataUri }] } };
      return undefined;
    });
    const failed = expectState(await sent(run), "failed");
    expect(failed.reason.message).toContain("media limit");
    expect(failed.costs).toEqual([{ state: "pending", lookup: { upstream: "sandbase", predictionId: "r7" } }]);
    expect(submits(sb.seen)).toHaveLength(1);
  });

  it("makes the cost missing, with a warning, when an over-limit submit answer names no id in its headers", async () => {
    const { run } = runner();
    sb.answer(({ method, path }) => {
      if (method === "POST" && path === "/v1/run") return { status: 200, body: { id: "r8", status: "completed", outputs: [{ url: bigDataUri }] } };
      return undefined;
    });
    const failed = expectState(await sent(run), "failed");
    expect(failed.costs.map((c) => c.state)).toEqual(["missing"]);
    expect(failed.warnings.map((w) => w.code)).toContain("cost_unavailable");
  });
});

describe("SandBase costs", () => {
  /**
   * A run that finishes on SandBase, with the cost endpoint answering as given.
   * @param reply - What the task cost endpoint answers.
   * @returns The done answer and the provider.
   */
  async function finished(reply: Reply): Promise<{ done: Extract<MediaAnswer, { state: "done" }>; provider: ReturnType<typeof createProvider> }> {
    const { run, provider } = runner();
    sb.answer(({ method, path }) => {
      if (method === "POST" && path === "/v1/run") return { status: 202, body: { id: "r9", status: "pending" } };
      if (path === "/v1/run/r9") return { status: 200, body: { id: "r9", status: "completed", outputs: [{ url: "https://media.example/r9.png" }] } };
      if (path === "/v1/tasks/r9/cost") return reply;
      return undefined;
    });
    const running = expectState(await sent(run), "running");
    return { done: expectState(await run.poll(stored(running.ticket), live()), "done"), provider };
  }

  it("leaves an unsettled cost pending, and missing on the last lookup", async () => {
    const { done, provider } = await finished(taskCost(false, "0.020000"));
    expect(done.costs).toEqual([{ state: "pending", lookup: { upstream: "sandbase", predictionId: "r9" } }]);
    expect((await provider.cost.lookup({ upstream: "sandbase", predictionId: "r9" }, { lastAttempt: true })).state).toBe("missing");
  });

  it.each([["a cost that is not a number", { cost: "n/a" }], ["no cost", {}], ["a null cost", { cost: null }], ["an empty cost", { cost: "" }], ["a false cost", { cost: false }]])("leaves a cost pending, with a warning, when the cost answer has %s, and missing on the last lookup", async (_label, cost) => {
    const { done, provider } = await finished({ status: 200, body: { id: "r9", status: "completed", settled: true, currency: "USD", ...cost } });
    expect(done.costs).toEqual([{ state: "pending", lookup: { upstream: "sandbase", predictionId: "r9" } }]);
    expect(done.warnings.map((w) => w.code)).toContain("billing_query_empty");
    expect((await provider.cost.lookup({ upstream: "sandbase", predictionId: "r9" }, { lastAttempt: true })).state).toBe("missing");
  });

  it("fails a run SandBase answers failed at submit, with its words, and looks up its cost", async () => {
    const { run } = runner();
    sb.answer(({ method, path }) => {
      if (method === "POST" && path === "/v1/run") return { status: 200, body: { id: "r10", status: "failed", error: "content rejected" } };
      if (path === "/v1/tasks/r10/cost") return taskCost(true, "0.010000");
      return undefined;
    });
    const failed = expectState(await sent(run), "failed");
    expect(failed.reason).toBeInstanceOf(UpstreamTaskFailed);
    expect((failed.reason as UpstreamTaskFailed).upstreamError).toContain("content rejected");
    expect(failed.costs).toEqual([{ state: "pending", lookup: { upstream: "sandbase", predictionId: "r10" } }]);
  });

  it("leaves a cost pending, with a warning, when the cost endpoint answers 503", async () => {
    const { done } = await finished({ status: 503, body: { error: "busy" } });
    expect(done.costs).toEqual([{ state: "pending", lookup: { upstream: "sandbase", predictionId: "r9" } }]);
    expect(done.warnings.map((w) => w.code)).toContainEqual(expect.stringMatching(/^billing_query_/));
  });

  it("leaves a cost pending while the cost endpoint does not know the run", async () => {
    const { done } = await finished({ status: 404, body: { error: "task not found" } });
    expect(done.costs).toEqual([{ state: "pending", lookup: { upstream: "sandbase", predictionId: "r9" } }]);
  });
});

describe("SandBase refusals", () => {
  it("moves to the next upstream when SandBase says the balance is too low", async () => {
    const { run } = runner();
    sb.answer(() => ({ status: 402, body: { error: "insufficient credit for estimated video cost" } }));
    ws.answer(() => accepted("w1"));
    const moved = expectState(await sent(run), "send");
    expect(moved.warnings[0]?.detail.failure).toBe("insufficient_balance");
  });

  it("fails the run, without a retry, when SandBase is the last upstream and the balance is too low", async () => {
    const { run } = runner();
    sb.answer(() => ({ status: 402, body: { error: "insufficient balance" } }));
    const failed = expectState(await sent(run, "flux-only"), "failed");
    expect(failed.reason).toBeInstanceOf(NoUpstreamAvailable);
  });

  it("moves to the next upstream when SandBase has no such model", async () => {
    const { run } = runner();
    sb.answer(() => ({ status: 404, body: { error: "model not found: bfl/flux-2/flash" } }));
    ws.answer(() => accepted("w2"));
    const moved = expectState(await sent(run), "send");
    expect(moved.warnings[0]?.detail.failure).toBe("model_not_found");
  });

  it("stays on SandBase and fails the run on a 400 refusal of the input", async () => {
    const { run } = runner();
    sb.answer(() => ({ status: 400, body: { error: "invalid capability input" } }));
    const failed = expectState(await sent(run), "failed");
    expect(failed.reason).toBeInstanceOf(UpstreamRequestRejected);
    expect(submits(ws.seen)).toHaveLength(0);
  });
});

/** A MiniMax voice clone on SandBase: the clone, then speech in the cloned voice. */
const VOICE: ProviderConfigInput["media"]["models"] = {
  "voice-clone": {
    upstreams: [{
      upstream: "sandbase",
      weight: 1,
      model_id: "minimax/voice-clone",
      prompt_field: "text",
      params: { audio: { field: "audio" } },
      extra_steps: [{ kind: "speak", endpoint: "minimax/speech/2.8/hd", at: "after" }],
      reused_by: "audio",
      pricing,
    }],
  }
};

describe("a MiniMax voice clone on SandBase", () => {
  const speech = { prompt: "hello there", params: { audio: "https://cdn.example/voice.mp3" } };
  const keyed = { idempotencyKey: "task-1", sourceKeys: { "https://cdn.example/voice.mp3": "sha-a" } };

  it("clones without naming an id or a preview text, reads the id SandBase made, and speaks with it", async () => {
    const { run } = runner(undefined, VOICE);
    sb.answer(({ method, path, body }) => {
      const model = (body as { model?: string } | undefined)?.model;
      if (method === "POST" && path === "/v1/run" && model === "minimax/voice-clone") return { status: 202, body: { id: "c1", status: "pending" } };
      if (method === "POST" && path === "/v1/run" && model === "minimax/speech/2.8/hd") return { status: 202, body: { id: "s1", status: "pending" } };
      if (path === "/v1/run/c1") return { status: 200, body: { id: "c1", status: "completed", outputs: [{ custom_voice_id: "sb-voice-1", url: "https://media.example/c1/preview.mp3" }] } };
      if (path === "/v1/run/s1") return { status: 200, body: { id: "s1", status: "completed", outputs: [{ content_type: "audio/mpeg", url: "https://media.example/s1/0.mp3" }] } };
      if (path.startsWith("/v1/tasks/")) return taskCost(true, "0.010000");
      return undefined;
    });
    const clones: unknown[] = [];
    let answer: MediaAnswer = expectState(await run.plan("voice-clone", speech, { mode: "default" }, { ...keyed, clones: [], durations: {} }), "send");
    expect(answer.step.kind).toBe("voice");
    for (let i = 0; i < 10 && answer.state !== "done" && answer.state !== "failed"; i++) {
      answer = answer.state === "send" ? await run.send(stored(answer.ticket), live()) : await run.poll(stored(answer.ticket), live());
      if ("clones" in answer) clones.push(...answer.clones);
    }
    const done = expectState(answer, "done");
    expect(submits(sb.seen).map((s) => s.body)).toEqual([
      { model: "minimax/voice-clone", audio: "https://cdn.example/voice.mp3" },
      { model: "minimax/speech/2.8/hd", text: "hello there", voice_id: "sb-voice-1" },
    ]);
    expect(clones).toEqual([{ upstream: "sandbase", kind: "voice", sourceKey: "sha-a", upstreamId: "sb-voice-1" }]);
    expect(done.outputs).toEqual([{ kind: "url", url: "https://media.example/s1/0.mp3" }]);
  });

  it("speaks with SandBase's cached clone and skips the clone step", async () => {
    const { run } = runner(undefined, VOICE);
    sb.answer(({ method }) => (method === "POST" ? { status: 202, body: { id: "s1", status: "pending" } } : { status: 200, body: { id: "s1", status: "running" } }));
    const cached = [{ upstream: "sandbase", kind: "voice" as const, sourceKey: "sha-a", upstreamId: "sb-voice-9" }];
    const planned = expectState(await run.plan("voice-clone", speech, { mode: "default" }, { ...keyed, clones: cached, durations: {} }), "send");
    expect(planned.step.kind).toBe("speak");
    await run.send(stored(planned.ticket), live());
    expect(submits(sb.seen).map((s) => s.body)).toEqual([{ model: "minimax/speech/2.8/hd", text: "hello there", voice_id: "sb-voice-9" }]);
  });

  it.each([
    ["answers the cached clone as retired when the speak step fails in MiniMax's words for a voice it no longer has", "MiniMax error: Voice ID does not exist", true],
    ["keeps the cached clone when the speak step fails for another reason", "content policy violation", false],
  ])("%s", async (_label, error, retired) => {
    const { run } = runner(undefined, VOICE);
    sb.answer(({ method, path }) => {
      if (method === "POST") return { status: 202, body: { id: "s1", status: "pending" } };
      if (path === "/v1/run/s1") return { status: 200, body: { id: "s1", status: "failed", error } };
      if (path.startsWith("/v1/tasks/")) return taskCost(true, "0");
      return undefined;
    });
    const cached = [{ upstream: "sandbase", kind: "voice" as const, sourceKey: "sha-a", upstreamId: "sb-voice-9" }];
    let answer: MediaAnswer = expectState(await run.plan("voice-clone", speech, { mode: "default" }, { ...keyed, clones: cached, durations: {} }), "send");
    for (let i = 0; i < 5 && answer.state !== "done" && answer.state !== "failed"; i++) {
      answer = answer.state === "send" ? await run.send(stored(answer.ticket), live()) : await run.poll(stored(answer.ticket), live());
    }
    expect(expectState(answer, "failed").retiredClones).toEqual(retired ? cached : []);
  });
});
