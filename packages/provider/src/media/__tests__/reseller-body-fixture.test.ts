// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { catalog, coveredValues, shipped, yaml } from "../../config/__tests__/shipped.js";
import { adapterOf } from "../adapters.js";
import { missingRequired, type SchemaSnapshot } from "../../config/upstream-schema.js";
import { firstBody, takes, type SampleRun } from "./reseller-bodies.js";

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

/** The reviewed request bodies of one reseller binding (`scripts/provider-reseller-bodies.ts`). */
interface BodySample {
  model: string;
  upstream: string;
  model_id: string;
  /** The first run is the one the application sends: every param at its default, the sources the model needs at a sample url and a voice from the upstream's list. */
  runs: SampleRun[];
  /** Values of a param that the binding takes in no run, each refused on the default run. */
  untaken?: { param: string; value: unknown }[];
  steps: { kind: string; endpoint: string; context: StepSampleContext; body: Record<string, unknown> }[];
}

const BODIES = resolve(__dirname, "../../../test/fixtures/bodies");
const config = shipped();
const offered = new Map(catalog().models.map((m) => [m.name, m.params as Record<string, { values?: unknown[]; min?: number; max?: number }>]));
const MODEL_FILES = ["image/models.yaml", "video/models.yaml", "audio/models.yaml", "tts/models.yaml", "three_d/meshy.yaml", "three_d/hunyuan3d.yaml"];
/** Per model, the params of which a run must carry at least one, per mode, as the catalog lists them. */
const sourceGroups = new Map(MODEL_FILES.flatMap((f) => yaml<{ models: { name: string; source_groups?: { mode: string; any_of: string[] }[] }[] }>(`models/${f}`).models.map((m) => [m.name, m.source_groups ?? []] as const)));
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

  it("send every field the upstream requires, as a run the application sends does", () => {
    const path = resolve(__dirname, "../../../test/fixtures/upstream-schemas", binding.upstream, `${binding.model_id}.json`);
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as SchemaSnapshot;
    const missing = sample.runs.flatMap((run) => missingRequired(snapshot, run.body).map((field) => `${field} in ${JSON.stringify(run.params)}`));
    expect(missing).toEqual([]);
  });

  it("start from a run the application sends, carrying the material the model's first source group needs", () => {
    const group = sourceGroups.get(model)?.[0];
    if (group === undefined) return;
    const first = sample.runs[0]!.params;
    expect(group.any_of.filter((p) => first[p] !== undefined && first[p] !== null), JSON.stringify(group)).not.toEqual([]);
  });

  it("sample each source with a file of the kind its param accepts", () => {
    const EXTENSIONS: Record<string, RegExp> = { image: /\.(png|jpe?g|webp)$/, video: /\.mp4$/, audio: /\.mp3$/ };
    const wrong: string[] = [];
    for (const [name, param] of Object.entries(offered.get(model) ?? {})) {
      const kind = (param as { accepts?: string }).accepts;
      const pattern = kind === undefined ? undefined : EXTENSIONS[kind];
      if (pattern === undefined) continue;
      for (const run of sample.runs) {
        const value = run.params[name];
        for (const url of (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string")) {
          if (!pattern.test(url)) wrong.push(`${name}=${url}`);
        }
      }
    }
    expect([...new Set(wrong)]).toEqual([]);
  });

  it("write each reference into the prompt the way the binding's mentions name it, in some run", () => {
    const unshown = Object.keys(binding.mentions ?? {}).filter((param) => {
      const drop = binding.drops?.[param];
      if (Array.isArray(drop) && drop.length === 0) return false;
      return !sample.runs.some((r) => r.prompt.includes(`<<ref:${param}:`) && r.params[param] !== undefined && r.params[param] !== null);
    });
    expect(unshown).toEqual([]);
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
