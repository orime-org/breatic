// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 §11.2–§11.3: what the batch 6 video tools need from a WaveSpeed run. SAM3 answers objects, and the link a
 * run hands over is the binding's `output_field`; an upstream's failed answer keeps its error object as `detail`, which
 * the application reads to tell a model refusal from other failures.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderConfigInput } from "../../config/schema.js";
import { UpstreamTaskFailed } from "../../errors.js";
import { createProvider } from "../../provider.js";
import { createMediaRunner, type MediaAnswer, type MediaRunner, type MediaTicket } from "../runner.js";
import { accepted, billing, fakeUpstream, result, type FakeUpstream } from "./fake-upstream.js";

const pricing = { kind: "formula", base_price: 0, formula: "", discount_rate: 100 };
let ws: FakeUpstream;

beforeEach(async () => {
  ws = await fakeUpstream();
});

afterEach(async () => {
  await ws.close();
});

/**
 * One WaveSpeed upstream on the fake with one model: SAM3, whose binding names its output field, or a plain eraser.
 * @param model - Which model the configuration carries.
 * @returns The runner.
 */
function runner(model: "sam3" | "eraser"): MediaRunner {
  const bindings = {
    sam3: { upstream: "ws", weight: 1, model_id: "wavespeed-ai/sam3-video-rle", params: { video: { field: "video" } }, output_field: "rle_url", pricing },
    eraser: { upstream: "ws", weight: 1, model_id: "bria/video-eraser/mask", params: { video: { field: "video" } }, pricing },
  };
  const config: ProviderConfigInput = {
    upstreams: { ws: { kind: "wavespeed", base_url: ws.url, key_env: "WS_KEY" } },
    media: {
      models: { [model]: { upstreams: [bindings[model]] } },
    },
  };
  const provider = createProvider({ config, keyOf: () => "key", llmMaxRetries: 0, cleanText: (text) => text });
  return createMediaRunner(provider, { mediaLimits: { maxMediaBytes: 1_000_000 }, pollIntervalMs: 0 });
}

/**
 * Narrow an answer to the state the case expects.
 * @param answer - The answer.
 * @param state - The state it must be in.
 * @returns The narrowed answer.
 */
function expectState<S extends MediaAnswer["state"]>(answer: MediaAnswer, state: S): Extract<MediaAnswer, { state: S }> {
  expect(answer.state).toBe(state);
  return answer as Extract<MediaAnswer, { state: S }>;
}

const stored = (ticket: MediaTicket): MediaTicket => JSON.parse(JSON.stringify(ticket)) as MediaTicket;
const live = (): { deadlineAt: number } => ({ deadlineAt: Date.now() + 60_000 });
const options = { idempotencyKey: "step-1", sourceKeys: {}, clones: [], durations: {} };

/**
 * Plan, send and ask once about one run.
 * @param r - The runner.
 * @param model - The model.
 * @returns The answer to the first question.
 */
async function askedOnce(r: MediaRunner, model: string): Promise<MediaAnswer> {
  const planned = expectState(await r.plan(model, { prompt: "", params: { video: "https://cdn.example/v.mp4" } }, { mode: "default" }, options), "send");
  const running = expectState(await r.send(stored(planned.ticket), live()), "running");
  return r.poll(stored(running.ticket), live());
}

describe("batch 6 WaveSpeed runs", () => {
  it("hand over the binding's output_field of an object output", async () => {
    ws.answer(({ method, path }) => {
      if (path === "/billings/search") return billing([]);
      return method === "POST" ? accepted("p1") : result("p1", "completed", [{ rle_url: "https://out.example/m.json", video_url: "https://out.example/m.mp4" }]);
    });
    const done = expectState(await askedOnce(runner("sam3"), "sam3"), "done");
    expect(done.outputs).toEqual([{ kind: "url", url: "https://out.example/m.json" }]);
  });

  it("keep the upstream's error object as the failure's detail", async () => {
    const refusal = { code: 1401, message: "unsupported frame rate" };
    ws.answer(({ method, path }) => {
      if (path === "/billings/search") return billing([]);
      return method === "POST" ? accepted("p1") : { status: 200, body: { code: 200, data: { id: "p1", status: "failed", outputs: [], error: refusal } } };
    });
    const failed = expectState(await askedOnce(runner("eraser"), "eraser"), "failed");
    expect(failed.reason).toBeInstanceOf(UpstreamTaskFailed);
    expect((failed.reason as UpstreamTaskFailed).detail).toEqual(refusal);
  });
});
