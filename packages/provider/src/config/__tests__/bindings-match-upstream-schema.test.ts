// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { MediaBinding } from "@provider/config/schema.js";
import { fieldFits, missingRequired, type SchemaSnapshot } from "@provider/config/upstream-schema.js";
import { adapterOf } from "@provider/media/adapters.js";
import { buildBody } from "@provider/media/body.js";
import type { StepContext } from "@provider/media/adapter.js";
import { ROOT, catalog, shipped } from "./shipped.js";

/** One param of our catalog as its yaml writes it. */
interface CatalogParam {
  values?: (string | number | boolean)[];
  min?: number;
  max?: number;
  step?: number;
  default?: unknown;
  type?: string;
  fields?: Record<string, { type?: string; values?: (string | number | boolean)[] }>;
  remote_source?: string;
  /** The media kind of a single-file param. */
  accepts?: string;
}

const SNAPSHOTS = resolve(ROOT, "packages/provider/test/fixtures/upstream-schemas");
const SAMPLE_URL = "https://example.com/sample.png";
const SAMPLE_TEXT = "sample text";

/**
 * The committed schema snapshot of one upstream endpoint.
 * @param upstream - The upstream's name.
 * @param endpoint - The model id or step endpoint on it.
 * @returns The snapshot, or undefined when none is committed.
 */
function snapshotFor(upstream: string, endpoint: string): SchemaSnapshot | undefined {
  const path = resolve(SNAPSHOTS, upstream, `${endpoint}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SchemaSnapshot) : undefined;
}

/**
 * The value at a dotted path of a body.
 * @param body - The body.
 * @param path - The path.
 * @returns The value, or undefined.
 */
function at(body: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, key) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined), body);
}

/**
 * Every value of a range from its low to its high end.
 * @param param - The range.
 * @returns The values.
 */
function everyStep(param: CatalogParam): number[] {
  const step = param.step ?? 1;
  const out: number[] = [];
  for (let v = param.min!; v <= param.max! + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/**
 * The sample values of one of our params that this binding sends: every offered value,
 * a range's ends and default (every step when the binding respells it or the upstream
 * types it differently), less those `supported` keeps out.
 * @param name - The param.
 * @param param - The catalog's param.
 * @param binding - The binding.
 * @param snapshot - The upstream's schema.
 * @returns The values.
 */
function samplesOf(name: string, param: CatalogParam, binding: MediaBinding, snapshot: SchemaSnapshot): unknown[] {
  const bound = binding.params?.[name];
  if (bound === undefined) return [];
  let values: unknown[];
  if (param.remote_source === "voices") values = Object.keys(binding.voice_map?.[name] ?? {}).length > 0 ? Object.keys(binding.voice_map![name]!) : (param.values ?? []);
  else if (param.values !== undefined) values = param.values;
  else if (param.min !== undefined && param.max !== undefined) {
    const numeric = (snapshot.fields[bound.field] ?? []).some((leaf) => leaf.type === "number" || leaf.type === "integer");
    values = bound.values !== undefined || bound.as !== undefined || !numeric ? everyStep(param) : [param.min, param.max, param.default ?? param.min];
  } else if (param.type === "items") values = [[sampleItem(param), sampleItem(param)]];
  else if (param.type === "list") values = [[SAMPLE_URL]];
  else if (param.accepts !== undefined) values = [SAMPLE_URL];
  else if (param.default !== undefined && param.default !== null) values = [param.default];
  else if (param.remote_source === undefined) values = [SAMPLE_TEXT];
  else values = [];
  return bound.supported === undefined ? values : values.filter((v) => bound.supported!.includes(v as string | number | boolean));
}

/**
 * One sample item of an `items` param from its fields.
 * @param param - The param.
 * @returns The item.
 */
function sampleItem(param: CatalogParam): Record<string, unknown> {
  return Object.fromEntries(Object.entries(param.fields ?? {}).map(([sub, f]) => [sub, f.values?.[0] ?? SAMPLE_TEXT]));
}

/**
 * The value a run sends for a param when it does not choose one.
 * @param name - The param.
 * @param param - The catalog's param.
 * @param binding - The binding.
 * @param snapshot - The upstream's schema.
 * @returns The value, or undefined.
 */
function defaultOf(name: string, param: CatalogParam, binding: MediaBinding, snapshot: SchemaSnapshot): unknown {
  return param.default ?? samplesOf(name, param, binding, snapshot)[0] ?? (param.remote_source === undefined ? undefined : SAMPLE_TEXT);
}

const config = shipped();
const models = new Map(catalog().models.map((m) => [m.name, m.params as Record<string, CatalogParam>]));
const cases = Object.entries(config.media.models).flatMap(([model, { upstreams }]) => upstreams.map((binding) => ({ model, binding })));

describe.each(cases)("$model on $binding.upstream", ({ model, binding }) => {
  const kind = config.upstreams[binding.upstream]?.kind;
  const snapshot = snapshotFor(binding.upstream, binding.model_id);
  const params = models.get(model) ?? {};

  it("has a committed schema snapshot", () => {
    expect(snapshot, `test/fixtures/upstream-schemas/${binding.upstream}/${binding.model_id}.json`).toBeDefined();
  });
  if (snapshot === undefined) return;

  it("writes its prompt and fixed fields into fields the upstream takes", () => {
    if (binding.prompt_field !== undefined) expect(fieldFits(snapshot, binding.prompt_field, SAMPLE_TEXT), binding.prompt_field).toBe(true);
    for (const [field, value] of Object.entries(binding.fixed ?? {})) {
      if (kind === "sandbase" && field === "mode") expect(snapshot.modes ?? [], "mode").toContain(value);
      else expect(fieldFits(snapshot, field, value), `${field}=${JSON.stringify(value)}`).toBe(true);
    }
  });

  it("reads its outputs from a field the upstream answers", () => {
    if (binding.output_field === undefined) return;
    expect(Object.keys(snapshot.outputs ?? {}), binding.output_field).toContain(binding.output_field);
  });

  it("writes every value of every param it sends as the upstream takes it", () => {
    const bad: string[] = [];
    for (const [name, param] of Object.entries(params)) {
      const field = binding.params?.[name]?.field;
      // A param an extra step serves is sent as what that step made, not as the run's value.
      if (field === undefined || binding.extra_steps?.some((step) => step.for_param === name)) continue;
      for (const value of samplesOf(name, param, binding, snapshot)) {
        const written = at(buildBody(binding, { prompt: "", params: { [name]: value } }), field);
        if (written === undefined) continue;
        if (!fieldFits(snapshot, field, written)) bad.push(`${name}=${JSON.stringify(value)} -> ${field}=${JSON.stringify(written)}`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("sends every field the upstream requires", () => {
    const sample = Object.fromEntries(Object.entries(params).map(([name, param]) => [name, defaultOf(name, param, binding, snapshot)]));
    expect(missingRequired(snapshot, buildBody(binding, { prompt: SAMPLE_TEXT, params: sample }))).toEqual([]);
  });

  it("writes its extra steps into fields their endpoints take", () => {
    for (const step of binding.extra_steps ?? []) {
      const stepSnapshot = snapshotFor(binding.upstream, step.endpoint);
      expect(stepSnapshot, `${binding.upstream}/${step.endpoint}.json`).toBeDefined();
      const codec = kind === undefined ? undefined : adapterOf(kind).steps[step.kind];
      if (stepSnapshot === undefined || codec === undefined) continue;
      const context: StepContext = {
        source: () => SAMPLE_URL,
        params: {},
        prompt: SAMPLE_TEXT,
        binding,
        customVoiceId: "voice-sample",
        voiceId: "voice-sample",
        description: SAMPLE_TEXT,
        itemIndex: 0,
        param: step.for_param,
      };
      const body = codec.body(context);
      for (const [field, value] of Object.entries(body)) expect(fieldFits(stepSnapshot, field, value), `${step.kind} ${field}`).toBe(true);
      expect(missingRequired(stepSnapshot, body), step.kind).toEqual([]);
    }
  });
});
