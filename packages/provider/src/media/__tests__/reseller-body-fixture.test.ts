// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { MediaBinding } from "../../config/schema.js";
import { catalog, shipped } from "../../config/__tests__/shipped.js";
import { adapterOf } from "../adapters.js";
import { buildBody } from "../body.js";

/** The step context a body sample was built with; `source` is the url the step reads. */
interface StepSampleContext {
  source: string;
  params: Record<string, unknown>;
  prompt: string;
  customVoiceId: string;
  voiceId: string | null;
  description: string | null;
  itemIndex: number | null;
  param: string | null;
}

/** The reviewed request bodies of one reseller binding (`scripts/provider-reseller-bodies.ts`). */
interface BodySample {
  model: string;
  upstream: string;
  model_id: string;
  runs: { params: Record<string, unknown>; prompt: string; body: Record<string, unknown> }[];
  steps: { kind: string; endpoint: string; context: StepSampleContext; body: Record<string, unknown> }[];
}

const BODIES = resolve(__dirname, "../../../test/fixtures/bodies");
const config = shipped();
const offered = new Map(catalog().models.map((m) => [m.name, m.params as Record<string, { values?: unknown[]; min?: number; max?: number }>]));
const cases = Object.entries(config.media.models).flatMap(([model, { upstreams }]) => upstreams.filter((b) => b.upstream !== "wavespeed").map((binding) => ({ model, binding })));

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
 * The values of a param a binding's sample must cover: each offered value it supports, a range's ends, a voice map's voices.
 * @param name - The param.
 * @param binding - The binding.
 * @param model - Our model.
 * @returns The values, or undefined when any present value will do.
 */
function coveredValues(name: string, binding: MediaBinding, model: string): unknown[] | undefined {
  const param = offered.get(model)?.[name];
  const voices = binding.voice_map?.[name];
  let values: unknown[] | undefined = voices !== undefined ? Object.keys(voices) : param?.values ?? (param?.min !== undefined && param.max !== undefined ? [param.min, param.max] : undefined);
  const supported = binding.params?.[name]?.supported;
  if (values !== undefined && supported !== undefined) values = values.filter((v) => supported.includes(v as string | number | boolean));
  return values;
}

describe.each(cases)("the request bodies of $model on $binding.upstream", ({ model, binding }) => {
  const sample = sampleOf(binding.upstream, model);

  it("have a committed sample", () => {
    expect(sample, `test/fixtures/bodies/${binding.upstream}/${model}.json`).toBeDefined();
    expect(sample?.model_id).toBe(binding.model_id);
  });
  if (sample === undefined) return;

  it("are what the binding builds for each sample run", () => {
    for (const run of sample.runs) expect(buildBody(binding, { params: run.params, prompt: run.prompt }), JSON.stringify(run.params)).toEqual(run.body);
  });

  it("cover every value of every param the binding sends", () => {
    const uncovered: string[] = [];
    for (const name of Object.keys(binding.params ?? {})) {
      const present = sample.runs.map((r) => r.params[name]).filter((v) => v !== undefined && v !== null);
      if (present.length === 0) uncovered.push(name);
      for (const value of coveredValues(name, binding, model) ?? []) {
        if (!present.some((v) => String(v) === String(value))) uncovered.push(`${name}=${JSON.stringify(value)}`);
      }
    }
    expect(uncovered).toEqual([]);
  });

  it("are what each extra step's codec builds", () => {
    const kind = config.upstreams[binding.upstream]!.kind;
    expect(sample.steps.map((s) => `${s.kind} ${s.endpoint}`).sort()).toEqual((binding.extra_steps ?? []).map((s) => `${s.kind} ${s.endpoint}`).sort());
    for (const step of sample.steps) {
      const codec = adapterOf(kind).steps[step.kind as keyof ReturnType<typeof adapterOf>["steps"]]!;
      const { source, voiceId, description, param, ...rest } = step.context;
      const body = codec.body({ ...rest, source: () => source, binding, voiceId: voiceId ?? undefined, description: description ?? undefined, param: param ?? undefined });
      expect(body, `${step.kind} ${step.endpoint}`).toEqual(step.body);
    }
  });
});
