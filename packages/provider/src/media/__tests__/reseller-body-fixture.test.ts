// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { MediaBinding } from "../../config/schema.js";
import { catalog, coveredValues, shipped } from "../../config/__tests__/shipped.js";
import { rejectedInput } from "../../pricing/estimate.js";
import { createProvider } from "../../provider.js";
import { adapterOf } from "../adapters.js";
import { buildBody } from "../body.js";

/** The step context a body sample was built with; `source` is the url the step reads, and absent fields are unset. */
interface StepSampleContext {
  source: string;
  params: Record<string, unknown>;
  prompt: string;
  customVoiceId: string;
  voiceId?: string;
  description?: string;
  itemIndex: number | null;
  param?: string;
}

/** One sample run: our params and prompt, the ids its extra steps answered for the params they serve, and the body sent. */
interface SampleRun {
  params: Record<string, unknown>;
  prompt: string;
  ids?: Record<string, string>;
  body: Record<string, unknown>;
}

/** The reviewed request bodies of one reseller binding (`scripts/provider-reseller-bodies.ts`). */
interface BodySample {
  model: string;
  upstream: string;
  model_id: string;
  /** The first run is the one the application sends with every param at its default. */
  runs: SampleRun[];
  /** Values of a param that the binding takes in no run, each refused on the default run. */
  untaken?: { param: string; value: unknown }[];
  steps: { kind: string; endpoint: string; context: StepSampleContext; body: Record<string, unknown> }[];
}

const BODIES = resolve(__dirname, "../../../test/fixtures/bodies");
const config = shipped();
const provider = createProvider({ config, keyOf: () => "k", llmMaxRetries: 0, cleanText: (t) => t });
const offered = new Map(catalog().models.map((m) => [m.name, m.params as Record<string, { values?: unknown[]; min?: number; max?: number }>]));
const cases = Object.entries(config.media.models).flatMap(([model, { upstreams }]) => upstreams.filter((b) => b.upstream !== "wavespeed").map((binding) => ({ model, binding })));
/** The clone id a voice step registers in the samples. */
const SAMPLE_VOICE_ID = "BreaticSample";

/**
 * The committed sample of a binding.
 * @param upstream - The upstream.
 * @param model - Our model.
 * @returns The sample, or undefined when none is committed.
 */
function sampleOf(upstream: string, model: string): BodySample | undefined {
  const path = resolve(BODIES, upstream, `${model}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as BodySample) : undefined;
}

/**
 * Whether the binding takes these params with this prompt.
 * @param model - Our model.
 * @param binding - The binding.
 * @param params - Our params.
 * @param prompt - The prompt.
 * @returns True when no limit, voice map or reject of the binding refuses them.
 */
async function takes(model: string, binding: MediaBinding, params: Record<string, unknown>, prompt: string): Promise<boolean> {
  return (await rejectedInput(provider.pricingRules(model), binding.upstream, { params, prompt, durations: {}, placeholders: [], durationsMissing: [] })) === undefined;
}

/**
 * The body of a run's first call as the runner sends it: the voice step's when the call clones a source, else the binding's.
 * @param binding - The binding.
 * @param run - The sample run.
 * @returns The body.
 */
function firstBody(binding: MediaBinding, run: SampleRun): Record<string, unknown> {
  const params = { ...run.params, ...run.ids };
  if (binding.reused_by === undefined) return buildBody(binding, { params, prompt: run.prompt });
  const voice = adapterOf(config.upstreams[binding.upstream]!.kind).steps.voice!;
  return voice.body({ source: () => String(run.params[binding.reused_by!]), params, prompt: run.prompt, binding, customVoiceId: SAMPLE_VOICE_ID, voiceId: undefined, description: undefined, itemIndex: null, param: undefined });
}

describe.each(cases)("the request bodies of $model on $binding.upstream", ({ model, binding }) => {
  const sample = sampleOf(binding.upstream, model);

  it("have a committed sample", () => {
    expect(sample, `test/fixtures/bodies/${binding.upstream}/${model}.json`).toBeDefined();
    expect(sample?.model_id).toBe(binding.model_id);
  });
  if (sample === undefined) return;

  it("show only runs the binding takes", async () => {
    const refused: string[] = [];
    for (const run of sample.runs) if (!(await takes(model, binding, run.params, run.prompt))) refused.push(JSON.stringify(run.params));
    expect(refused).toEqual([]);
  });

  it("are what the runner sends for each sample run, a param an extra step serves written as the id it answered", () => {
    const served = (binding.extra_steps ?? []).map((s) => s.for_param).filter((p): p is string => p !== undefined);
    for (const run of sample.runs) {
      for (const param of served) if (run.params[param] !== undefined && run.params[param] !== null) expect(run.ids?.[param], `${param} in ${JSON.stringify(run.params)}`).toBeDefined();
      expect(firstBody(binding, run), JSON.stringify(run.params)).toEqual(run.body);
    }
  });

  it("cover every value of every param the binding sends, or show the binding refuses it", async () => {
    const uncovered: string[] = [];
    const base = sample.runs[0]!;
    for (const name of Object.keys(binding.params ?? {})) {
      const present = sample.runs.map((r) => r.params[name]).filter((v) => v !== undefined && v !== null);
      const untaken = (sample.untaken ?? []).filter((u) => u.param === name);
      for (const u of untaken) {
        if (await takes(model, binding, { ...base.params, [name]: u.value }, base.prompt)) uncovered.push(`${name}=${JSON.stringify(u.value)} is listed as untaken but the binding takes it`);
      }
      if (present.length === 0 && untaken.length === 0) uncovered.push(name);
      for (const value of coveredValues(name, offered.get(model)?.[name], binding)) {
        if (!present.some((v) => String(v) === String(value)) && !untaken.some((u) => String(u.value) === String(value))) uncovered.push(`${name}=${JSON.stringify(value)}`);
      }
    }
    expect(uncovered).toEqual([]);
  });

  it("are what each extra step's codec builds", () => {
    const kind = config.upstreams[binding.upstream]!.kind;
    expect(sample.steps.map((s) => `${s.kind} ${s.endpoint}`).sort()).toEqual((binding.extra_steps ?? []).map((s) => `${s.kind} ${s.endpoint}`).sort());
    for (const step of sample.steps) {
      const codec = adapterOf(kind).steps[step.kind as keyof ReturnType<typeof adapterOf>["steps"]]!;
      expect(codec.body({ ...step.context, source: () => step.context.source, binding, voiceId: step.context.voiceId, description: step.context.description, param: step.context.param }), `${step.kind} ${step.endpoint}`).toEqual(step.body);
    }
  });
});
