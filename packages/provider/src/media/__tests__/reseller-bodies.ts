// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a reseller request-body sample is built from and checked against, shared by
 * scripts/provider-reseller-bodies.ts and reseller-body-fixture.test.ts.
 */

import type { MediaBinding, ProviderConfigInput } from "../../config/schema.js";
import { shipped } from "../../config/__tests__/shipped.js";
import { rejectedInput } from "../../pricing/estimate.js";
import { createProvider } from "../../provider.js";
import { createMediaRunner } from "../runner.js";
import { driven, fakeUpstream } from "./fake-upstream.js";

const config = shipped();
const provider = createProvider({ config, keyOf: () => "k", llmMaxRetries: 0, cleanText: (t) => t });

/** One sample run: our params and prompt, and the body the runner sent for the run's own call. */
export interface SampleRun {
  params: Record<string, unknown>;
  prompt: string;
  body: Record<string, unknown>;
}

/** The clone id a voice step registers in the samples. */
export const SAMPLE_VOICE_ID = "BreaticSample";

/**
 * Whether the binding takes these params with this prompt.
 * @param model - Our model.
 * @param binding - The binding.
 * @param params - Our params.
 * @param prompt - The prompt.
 * @returns True when no limit, voice map or reject of the binding refuses them.
 */
export async function takes(model: string, binding: MediaBinding, params: Record<string, unknown>, prompt: string): Promise<boolean> {
  return (await rejectedInput(provider.pricingRules(model), binding.upstream, { params, prompt, durations: {}, placeholders: [], durationsMissing: [] })) === undefined;
}

/** One request the runner sent for a sample run: the kind of step it served, the endpoint and the body as sent. */
export interface RunnerCall {
  kind: string;
  endpoint: string;
  body: Record<string, unknown>;
}

/**
 * What the upstream answers to one call in the samples: an id named after the step's kind, the clone id the call registered,
 * and a file at the binding's output field.
 * @param binding - The binding.
 * @param kind - The kind of step the call serves.
 * @param body - The body the call sent.
 * @returns The answer.
 */
function sampleAnswer(binding: MediaBinding, kind: string, body: Record<string, unknown>): Record<string, unknown> {
  const file = { url: `https://out.example/${kind}` };
  const answer: Record<string, unknown> = { id: `${kind}-id`, vocal_id: `${kind}-id`, custom_voice_id: body.custom_voice_id ?? SAMPLE_VOICE_ID, audio: file, ...file };
  if (kind !== "generate" || binding.output_field === undefined) return answer;
  const path = binding.output_field.split(".");
  let at = answer;
  for (const key of path.slice(0, -1)) at = at[key] = {};
  at[path.at(-1)!] = [file];
  return answer;
}

/**
 * Run a sample through the runner against a loopback stand-in for the binding's upstream, the binding as the model's only
 * one, and record every request it sent.
 * @param model - Our model.
 * @param binding - The binding.
 * @param run - The sample run.
 * @returns The calls, in the order the runner sent them.
 * @throws {Error} When the run fails, or needs a description step, which asks a language model.
 */
export async function runnerCalls(model: string, binding: MediaBinding, run: Pick<SampleRun, "params" | "prompt">): Promise<RunnerCall[]> {
  const fake = await fakeUpstream();
  try {
    const kind = config.upstreams[binding.upstream]!.kind;
    const pending: { kind: string }[] = [];
    const answered = new Map<string, Record<string, unknown>>();
    let n = 0;
    fake.answer(({ method, path, body }) => {
      if (method === "GET" && path.startsWith("/status/")) return { status: 200, body: { status: "COMPLETED" } };
      if (method === "GET" && path.startsWith("/result/")) return { status: 200, body: answered.get(path.slice("/result/".length)) };
      if (method === "GET" && path === "/models/billing-events") return { status: 200, body: { billing_events: [], has_more: false } };
      if (method !== "POST") return undefined;
      const id = `p${++n}`;
      const answer = sampleAnswer(binding, pending.at(-1)?.kind ?? "generate", body as Record<string, unknown>);
      if (kind === "sandbase") return { status: 200, body: { id, status: "completed", outputs: [answer] } };
      answered.set(id, answer);
      return { status: 200, body: { request_id: id, status_url: `${fake.url}/status/${id}`, response_url: `${fake.url}/result/${id}` } };
    });
    const only: ProviderConfigInput = {
      ...config,
      upstreams: { ...config.upstreams, [binding.upstream]: { ...config.upstreams[binding.upstream]!, base_url: fake.url, ...(kind === "fal" ? { billing_url: fake.url } : {}) } },
      media: { models: { ...config.media.models, [model]: { ...config.media.models[model]!, upstreams: [{ ...binding, weight: 0 }] } } },
    };
    const runner = createMediaRunner(createProvider({ config: only, keyOf: () => "k", llmMaxRetries: 0, cleanText: (t) => t }), { mediaLimits: { maxMediaBytes: 1_000_000 }, pollIntervalMs: 0 });
    const planned = await runner.plan(model, run, { mode: "upstream", upstream: binding.upstream }, { idempotencyKey: "Sample", sourceKeys: {}, clones: [], durations: {} });
    const { answer } = await driven(runner, planned, {
      bounds: () => ({ deadlineAt: Date.now() + 10_000 }),
      beforeSend: (step) => {
        if (step === "describe") throw new Error(`${model} on ${binding.upstream}: a description step asks a language model`);
        pending.push({ kind: step });
      },
    });
    if (answer.state === "failed") throw answer.reason;
    if (answer.state !== "done") throw new Error(`${model} on ${binding.upstream}: the sample run did not finish`);
    const posts = fake.seen.filter((s) => s.method === "POST");
    return posts.map((s, i) => {
      const body = s.body as Record<string, unknown>;
      return { kind: pending[i]!.kind, endpoint: kind === "sandbase" ? String(body.model) : s.path.slice(1), body };
    });
  } finally {
    await fake.close();
  }
}

/** An extra step of a sample, on the first run that makes it (`run`, an index into the runs), as the runner sent it. */
export interface SampleStep {
  kind: string;
  endpoint: string;
  run: number;
  body: Record<string, unknown>;
}

/**
 * The bodies the runner sends for a binding's sample runs: each run's own call (the voice call of a binding with
 * `reused_by`, the generate call otherwise) as the run's body, and each other step once, on the first run that makes it.
 * @param model - Our model.
 * @param binding - The binding.
 * @param runs - The sample runs.
 * @returns The runs with their bodies, and the steps.
 * @throws {Error} When a run fails, needs a description step, or the runner sends no call of its own.
 */
export async function sampledCalls(model: string, binding: MediaBinding, runs: readonly Pick<SampleRun, "params" | "prompt">[]): Promise<{ runs: SampleRun[]; steps: SampleStep[] }> {
  const own = binding.reused_by === undefined ? "generate" : "voice";
  const samples: SampleRun[] = [];
  const steps: SampleStep[] = [];
  for (const [index, run] of runs.entries()) {
    const calls = await runnerCalls(model, binding, run);
    const body = calls.find((c) => c.kind === own)?.body;
    if (body === undefined) throw new Error(`${model} on ${binding.upstream}: the runner sent no ${own} call for ${JSON.stringify(run.params)}`);
    samples.push({ params: run.params, prompt: run.prompt, body });
    for (const call of calls.filter((c) => c.kind !== own)) if (!steps.some((s) => s.kind === call.kind)) steps.push({ ...call, run: index });
  }
  return { runs: samples, steps };
}
