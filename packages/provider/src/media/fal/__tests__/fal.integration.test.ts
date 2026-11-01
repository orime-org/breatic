// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MediaBinding, ProviderConfigInput } from "../../../config/schema.js";
import { NoUpstreamAvailable, UpstreamRequestRejected, UpstreamTaskFailed } from "../../../errors.js";
import { createProvider } from "../../../provider.js";
import { createMediaRunner, type MediaAnswer, type MediaRunner, type MediaTicket } from "../../runner.js";
import { accepted, fakeUpstream, submits, type FakeUpstream, type Reply } from "../../__tests__/fake-upstream.js";

const pricing = { kind: "formula", base_price: 100_000, formula: "", discount_rate: 100 };

let fal: FakeUpstream;
let ws: FakeUpstream;

beforeEach(async () => {
  fal = await fakeUpstream();
  ws = await fakeUpstream();
});

afterEach(async () => {
  await Promise.all([fal.close(), ws.close()]);
});

/**
 * fal's answer to a submit: the request id and where to ask about it.
 * @param id - The request id.
 * @param app - The owner/app the status and result live under.
 * @returns The reply.
 */
const queued = (id: string, app = "custom/place"): Reply => ({
  status: 200,
  body: { request_id: id, status_url: `${fal.url}/${app}/requests/${id}/status`, response_url: `${fal.url}/${app}/requests/${id}`, queue_position: 0 },
});

/**
 * fal's billing events for one request.
 * @param totals - The cost of each event.
 * @returns The reply.
 */
const events = (totals: number[]): Reply => ({
  status: 200,
  body: { billing_events: totals.map((cost_total, i) => ({ request_id: `e${i}`, cost_total, quantity: 1 })), next_cursor: null, has_more: false },
});

/**
 * The bindings of these cases' models: each on fal first (the case may switch to WaveSpeed second).
 * @param model - The fal model id.
 * @param output - The fal output field.
 * @param extra - Fields to add to the fal binding.
 * @returns The bindings.
 */
function onFal(model: string, output: string, extra: Partial<MediaBinding> = {}): MediaBinding[] {
  return [
    { upstream: "fal", weight: 1, model_id: model, prompt_field: "prompt", params: { duration: { field: "duration", as: "string" } }, output_field: output, pricing, ...extra },
    { upstream: "ws", weight: 2, model_id: "ws/model", prompt_field: "prompt", params: { duration: { field: "duration" } }, pricing },
  ];
}

/**
 * The configuration: fal and a WaveSpeed-kind fake.
 * @param extra - More models.
 * @returns The raw configuration.
 */
function config(extra: ProviderConfigInput["media"]["models"] = {}): ProviderConfigInput {
  return {
    upstreams: {
      fal: { kind: "fal", base_url: fal.url, billing_url: `${fal.url}/v1`, key_env: "FAL_KEY" },
      ws: { kind: "wavespeed", base_url: ws.url, key_env: "WS_KEY" },
    },
    media: {
      models: {
        video: { upstreams: onFal("bytedance/seedance-2.5/us/text-to-video", "video", { fixed: { task: "extension" } }) },
        image: { upstreams: onFal("fal-ai/nano-banana-2", "images") },
        song: {
          upstreams: [{
            upstream: "fal",
            weight: 1,
            model_id: "mureka/v9.5/generate/song",
            prompt_field: "prompt",
            params: { song: { field: "reference_id" }, vocal: { field: "vocal_id" } },
            extra_steps: [
              { kind: "upload_reference", endpoint: "mureka/api/files/upload", at: "before", for_param: "song" },
              { kind: "vocal", endpoint: "mureka/api/voice/clone", at: "before", for_param: "vocal" },
            ],
            output_field: "audio",
            pricing,
          }],
        },
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
function runner(keys: Record<string, string> = { FAL_KEY: "fal-key", WS_KEY: "ws-key" }, extra: ProviderConfigInput["media"]["models"] = {}): { run: MediaRunner; provider: ReturnType<typeof createProvider> } {
  const provider = createProvider({ config: config(extra), keyOf: (name) => keys[name], llmMaxRetries: 0, cleanText: (t) => t });
  return { run: createMediaRunner(provider, { mediaLimits: { maxMediaBytes: 1_000_000 }, pollIntervalMs: 0 }), provider };
}

const stored = (ticket: MediaTicket): MediaTicket => JSON.parse(JSON.stringify(ticket)) as MediaTicket;
const live = (): { deadlineAt: number } => ({ deadlineAt: Date.now() + 60_000 });
const options = { idempotencyKey: "task-1", sourceKeys: {}, clones: [] };

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
 * Plan and send a run, answering the ticket the send hands back.
 * @param r - The runner.
 * @param model - The model.
 * @param params - Our params.
 * @returns The send's answer.
 */
async function sent(r: MediaRunner, model: string, params: Record<string, unknown> = { duration: 5 }): Promise<MediaAnswer> {
  const planned = expectState(await r.plan(model, { prompt: "a fox", params }, { mode: "default" }, options), "send");
  return r.send(stored(planned.ticket), live());
}

describe("fal submit and queue", () => {
  it("submits to the model path with Key auth and the fixed fields, then asks the status and result addresses fal answered", async () => {
    const { run } = runner();
    fal.answer(({ method, path }) => {
      if (method === "POST" && path === "/bytedance/seedance-2.5/us/text-to-video") return queued("r1");
      if (path === "/custom/place/requests/r1/status") return { status: 200, body: { status: "COMPLETED" } };
      if (path === "/custom/place/requests/r1") return { status: 200, body: { video: { url: "https://v.fal.media/out.mp4", content_type: "video/mp4" } } };
      if (path === "/v1/models/billing-events") return events([0.2, 0.05]);
      return undefined;
    });
    const running = expectState(await sent(run, "video"), "running");
    const submit = submits(fal.seen)[0]!;
    expect(submit.authorization).toBe("Key fal-key");
    expect(submit.body).toEqual({ prompt: "a fox", duration: "5", task: "extension" });
    const done = expectState(await run.poll(stored(running.ticket), live()), "done");
    expect(done.outputs).toEqual([{ kind: "url", url: "https://v.fal.media/out.mp4" }]);
    expect(done.costs).toEqual([{ state: "known", usd: 0.25, source: "billing" }]);
    const billing = fal.seen.find((s) => s.path === "/v1/models/billing-events")!;
    expect(new URLSearchParams(billing.query).get("request_id")).toBe("r1");
    expect(Date.parse(new URLSearchParams(billing.query).get("start")!)).toBeLessThan(Date.now() - 29 * 24 * 3600 * 1000);
    expect(billing.authorization).toBe("Key fal-key");
  });

  it("reads every file of a list output field", async () => {
    const { run } = runner();
    fal.answer(({ path }) => {
      if (path === "/fal-ai/nano-banana-2") return queued("r2");
      if (path.endsWith("/r2/status")) return { status: 200, body: { status: "COMPLETED" } };
      if (path.endsWith("/r2")) return { status: 200, body: { images: [{ url: "https://i/1.png" }, { url: "https://i/2.png" }] } };
      if (path === "/v1/models/billing-events") return events([0.08]);
      return undefined;
    });
    const running = expectState(await sent(run, "image"), "running");
    const done = expectState(await run.poll(stored(running.ticket), live()), "done");
    expect(done.outputs).toEqual([{ kind: "url", url: "https://i/1.png" }, { kind: "url", url: "https://i/2.png" }]);
  });

  it("keeps running while the request is queued or in progress", async () => {
    const { run } = runner();
    fal.answer(({ path }) => {
      if (path === "/bytedance/seedance-2.5/us/text-to-video") return queued("r3");
      if (path.endsWith("/r3/status")) return { status: 202, body: { status: "IN_PROGRESS" } };
      return undefined;
    });
    const running = expectState(await sent(run, "video"), "running");
    expectState(await run.poll(stored(running.ticket), live()), "running");
  });

  it("fails the run when the completed status carries an error, with fal's words", async () => {
    const { run } = runner();
    fal.answer(({ path }) => {
      if (path === "/bytedance/seedance-2.5/us/text-to-video") return queued("r4");
      if (path.endsWith("/r4/status")) return { status: 200, body: { status: "COMPLETED", error: "content policy violation", error_type: "content_policy_violation" } };
      if (path === "/v1/models/billing-events") return events([]);
      return undefined;
    });
    const running = expectState(await sent(run, "video"), "running");
    const failed = expectState(await run.poll(stored(running.ticket), live()), "failed");
    expect(failed.reason).toBeInstanceOf(UpstreamTaskFailed);
    expect((failed.reason as UpstreamTaskFailed).upstreamError).toContain("content policy violation");
  });

  it("asks again when the result answers 503, and finishes when it answers next", async () => {
    const { run } = runner();
    // The HTTP module resends a read up to three deliveries within one poll; every one of the first poll answers 503.
    let resultAsks = 0;
    fal.answer(({ path }) => {
      if (path === "/bytedance/seedance-2.5/us/text-to-video") return queued("r5");
      if (path.endsWith("/r5/status")) return { status: 200, body: { status: "COMPLETED" } };
      if (path.endsWith("/r5")) return ++resultAsks <= 3 ? { status: 503, body: { detail: "busy" } } : { status: 200, body: { video: { url: "https://v/5.mp4" } } };
      if (path === "/v1/models/billing-events") return events([0.1]);
      return undefined;
    });
    const running = expectState(await sent(run, "video"), "running");
    const again = expectState(await run.poll(stored(running.ticket), live()), "running");
    expect(again.warnings.map((w) => w.code)).toContain("poll_request_failed");
    expectState(await run.poll(stored(again.ticket), live()), "done");
  });

  it("fails the run when the result answers 422, the model's own refusal", async () => {
    const { run } = runner();
    fal.answer(({ path }) => {
      if (path === "/bytedance/seedance-2.5/us/text-to-video") return queued("r6");
      if (path.endsWith("/r6/status")) return { status: 200, body: { status: "COMPLETED" } };
      if (path.endsWith("/r6")) return { status: 422, body: { detail: [{ msg: "no media generated", type: "no_media_generated" }] } };
      if (path === "/v1/models/billing-events") return events([]);
      return undefined;
    });
    const running = expectState(await sent(run, "video"), "running");
    const failed = expectState(await run.poll(stored(running.ticket), live()), "failed");
    expect(failed.reason).toBeInstanceOf(UpstreamTaskFailed);
    expect((failed.reason as UpstreamTaskFailed).upstreamError).toContain("no media generated");
  });
});

describe("fal costs", () => {
  /**
   * A run that finishes on fal, with billing answering as given.
   * @param reply - What the billing events endpoint answers.
   * @returns The done answer and the provider.
   */
  async function finished(reply: Reply): Promise<{ done: Extract<MediaAnswer, { state: "done" }>; provider: ReturnType<typeof createProvider> }> {
    const { run, provider } = runner();
    fal.answer(({ path }) => {
      if (path === "/bytedance/seedance-2.5/us/text-to-video") return queued("r7");
      if (path.endsWith("/r7/status")) return { status: 200, body: { status: "COMPLETED" } };
      if (path.endsWith("/r7")) return { status: 200, body: { video: { url: "https://v/7.mp4" } } };
      if (path === "/v1/models/billing-events") return reply;
      return undefined;
    });
    const running = expectState(await sent(run, "video"), "running");
    return { done: expectState(await run.poll(stored(running.ticket), live()), "done"), provider };
  }

  it("leaves a cost pending while billing has no event, and missing when the last lookup finds none", async () => {
    const { done, provider } = await finished(events([]));
    expect(done.costs).toEqual([{ state: "pending", lookup: { upstream: "fal", predictionId: "r7" } }]);
    expect(await provider.cost.lookup({ upstream: "fal", predictionId: "r7" }, { lastAttempt: false })).toEqual({ state: "pending", lookup: { upstream: "fal", predictionId: "r7" } });
    expect((await provider.cost.lookup({ upstream: "fal", predictionId: "r7" }, { lastAttempt: true })).state).toBe("missing");
  });

  it("makes a cost missing at once when billing refuses the key, naming the permission", async () => {
    const { done } = await finished({ status: 403, body: { error: { type: "authorization_error", message: "forbidden" } } });
    expect(done.costs).toHaveLength(1);
    expect(done.costs[0]!.state).toBe("missing");
    expect((done.costs[0] as { reason: string }).reason).toContain("FAL_KEY");
    expect((done.costs[0] as { reason: string }).reason).toContain("billing:usage:read");
    expect(done.warnings.map((w) => w.code)).toContain("billing_query_rejected");
  });
});

describe("fal refusals", () => {
  it("moves to the next upstream when fal says the account is locked for its balance", async () => {
    const { run } = runner();
    fal.answer(() => ({ status: 403, body: { detail: "User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing." } }));
    ws.answer(() => accepted("w1"));
    const moved = expectState(await sent(run, "video"), "send");
    expect(moved.warnings).toEqual([{ code: "upstream_switched", detail: { model: "video", from: "fal", to: "ws", failure: "insufficient_balance" } }]);
  });

  it("fails the run, without a retry, when the last upstream says its balance is too low", async () => {
    const { run } = runner({ FAL_KEY: "fal-key" });
    fal.answer(() => ({ status: 403, body: { detail: "User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing." } }));
    const failed = expectState(await sent(run, "video"), "failed");
    expect(failed.reason).toBeInstanceOf(NoUpstreamAvailable);
  });

  it("moves to the next upstream when fal has no such application", async () => {
    const { run } = runner();
    fal.answer(() => ({ status: 404, body: { detail: 'Application "seedance-2.5" not found' } }));
    ws.answer(() => accepted("w2"));
    const moved = expectState(await sent(run, "video"), "send");
    expect(moved.warnings[0]?.detail.failure).toBe("model_not_found");
  });

  it("stays on fal and fails the run on a 422 refusal of the params", async () => {
    const { run } = runner();
    fal.answer(() => ({ status: 422, body: { detail: [{ loc: ["body", "duration"], msg: "invalid", type: "enum" }] } }));
    const failed = expectState(await sent(run, "video"), "failed");
    expect(failed.reason).toBeInstanceOf(UpstreamRequestRejected);
    expect(submits(ws.seen)).toHaveLength(0);
  });
});

describe("fal extra steps", () => {
  it("uploads a reference song and clones a vocal before the song, and sends the ids they answered", async () => {
    const { run } = runner();
    fal.answer(({ method, path }) => {
      if (method === "POST" && path === "/mureka/api/files/upload") return queued("u1", "mureka/api");
      if (method === "POST" && path === "/mureka/api/voice/clone") return queued("c1", "mureka/api");
      if (method === "POST" && path === "/mureka/v9.5/generate/song") return queued("s1", "mureka/v9.5");
      if (path.endsWith("/status")) return { status: 200, body: { status: "COMPLETED" } };
      if (path === "/mureka/api/requests/u1") return { status: 200, body: { id: "upload-77", purpose: "reference" } };
      if (path === "/mureka/api/requests/c1") return { status: 200, body: { vocal_id: "vocal-9" } };
      if (path === "/mureka/v9.5/requests/s1") return { status: 200, body: { audio: { url: "https://a/song.mp3" } } };
      if (path === "/v1/models/billing-events") return events([0.01]);
      return undefined;
    });
    let answer = await sent(run, "song", { song: "https://cdn.example/ref.mp3", vocal: "https://cdn.example/voice.mp3" });
    for (let i = 0; i < 10 && answer.state !== "done" && answer.state !== "failed"; i++) {
      answer = answer.state === "send" ? await run.send(stored(answer.ticket), live()) : await run.poll(stored(answer.ticket), live());
    }
    expectState(answer, "done");
    const posted = submits(fal.seen);
    expect(posted.map((s) => [s.path, s.body])).toEqual([
      ["/mureka/api/files/upload", { file_url: "https://cdn.example/ref.mp3", purpose: "reference" }],
      ["/mureka/api/voice/clone", { audio_url: "https://cdn.example/voice.mp3" }],
      ["/mureka/v9.5/generate/song", { prompt: "a fox", reference_id: "upload-77", vocal_id: "vocal-9" }],
    ]);
  });
});

/** A MiniMax voice clone on fal: the clone, then speech in the cloned voice. */
const VOICE: ProviderConfigInput["media"]["models"] = {
  "voice-clone": {
    upstreams: [{
      upstream: "fal",
      weight: 1,
      model_id: "fal-ai/minimax/voice-clone",
      prompt_field: "text",
      params: { audio: { field: "audio_url" } },
      extra_steps: [{ kind: "speak", endpoint: "fal-ai/minimax/speech-2.8-hd", at: "after" }],
      reused_by: "audio",
      output_field: "audio",
      pricing,
    }],
  }
};

describe("a MiniMax voice clone on fal", () => {
  const speech = { prompt: "hello there", params: { audio: "https://cdn.example/voice.mp3" } };
  const keyed = { idempotencyKey: "task-1", sourceKeys: { "https://cdn.example/voice.mp3": "sha-a" } };

  /**
   * Drive a run until it is done or failed, collecting the clones it reports.
   * @param r - The runner.
   * @param first - The plan's answer.
   * @returns The last answer and every clone reported on the way.
   */
  async function driven(r: MediaRunner, first: MediaAnswer): Promise<{ last: MediaAnswer; clones: unknown[] }> {
    const clones: unknown[] = [];
    let answer = first;
    for (let i = 0; i < 10 && answer.state !== "done" && answer.state !== "failed"; i++) {
      answer = answer.state === "send" ? await r.send(stored(answer.ticket), live()) : await r.poll(stored(answer.ticket), live());
      if ("clones" in answer) clones.push(...answer.clones);
    }
    return { last: answer, clones };
  }

  it("clones without naming an id or a preview text, reads the id fal made, and speaks with it", async () => {
    const { run } = runner(undefined, VOICE);
    fal.answer(({ method, path }) => {
      if (method === "POST" && path === "/fal-ai/minimax/voice-clone") return queued("c1", "fal-ai/minimax");
      if (method === "POST" && path === "/fal-ai/minimax/speech-2.8-hd") return queued("s1", "fal-ai/minimax");
      if (path.endsWith("/status")) return { status: 200, body: { status: "COMPLETED" } };
      if (path === "/fal-ai/minimax/requests/c1") return { status: 200, body: { custom_voice_id: "fal-voice-1", audio: null } };
      if (path === "/fal-ai/minimax/requests/s1") return { status: 200, body: { audio: { url: "https://a/speech.mp3" }, duration_ms: 1200 } };
      if (path === "/v1/models/billing-events") return events([0.01]);
      return undefined;
    });
    const planned = expectState(await run.plan("voice-clone", speech, { mode: "default" }, { ...keyed, clones: [] }), "send");
    expect(planned.step.kind).toBe("voice");
    const { last, clones } = await driven(run, planned);
    const done = expectState(last, "done");
    expect(submits(fal.seen).map((s) => [s.path, s.body])).toEqual([
      ["/fal-ai/minimax/voice-clone", { audio_url: "https://cdn.example/voice.mp3" }],
      ["/fal-ai/minimax/speech-2.8-hd", { prompt: "hello there", voice_setting: { voice_id: "fal-voice-1" } }],
    ]);
    expect(clones).toEqual([{ upstream: "fal", kind: "voice", sourceKey: "sha-a", upstreamId: "fal-voice-1" }]);
    expect(done.outputs).toEqual([{ kind: "url", url: "https://a/speech.mp3" }]);
  });

  it("speaks with fal's cached clone and skips the clone step", async () => {
    const { run } = runner(undefined, VOICE);
    fal.answer(({ method }) => (method === "POST" ? queued("s1", "fal-ai/minimax") : { status: 200, body: { status: "IN_PROGRESS" } }));
    const cached = [{ upstream: "fal", kind: "voice" as const, sourceKey: "sha-a", upstreamId: "fal-voice-9" }];
    const planned = expectState(await run.plan("voice-clone", speech, { mode: "default" }, { ...keyed, clones: cached }), "send");
    expect(planned.step.kind).toBe("speak");
    await run.send(stored(planned.ticket), live());
    expect(submits(fal.seen).map((s) => s.body)).toEqual([{ prompt: "hello there", voice_setting: { voice_id: "fal-voice-9" } }]);
  });
});
