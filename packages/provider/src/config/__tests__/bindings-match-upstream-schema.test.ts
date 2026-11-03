// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { MediaBinding } from "@provider/config/schema.js";
import { fieldFits, missingRequired, type Leaf, type SchemaSnapshot } from "@provider/config/upstream-schema.js";
import { adapterOf } from "@provider/media/adapters.js";
import { buildBody } from "@provider/media/body.js";
import type { StepContext } from "@provider/media/adapter.js";
import { rejectedInput } from "@provider/pricing/estimate.js";
import { createProvider } from "@provider/provider.js";
import { ROOT, catalog, shipped, yaml } from "./shipped.js";

/** One param of our catalog as its yaml writes it. */
interface CatalogParam {
  values?: (string | number | boolean)[];
  min?: number;
  max?: number;
  step?: number;
  default?: unknown;
  type?: string;
  fields?: Record<string, { type?: string; values?: (string | number | boolean)[]; max_chars?: number }>;
  /** The longest text a text param takes. */
  max_chars?: number;
  /** For shots: the line each is written into the prompt as, when they are not sent as a list. */
  into_prompt?: string;
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

/**
 * The context an extra step's body is built from, with sample values.
 * @param binding - The binding.
 * @param param - The param the step serves.
 * @returns The context.
 */
function sampleStep(binding: MediaBinding, param: string | undefined): StepContext {
  return {
    source: () => SAMPLE_URL,
    params: {},
    prompt: SAMPLE_TEXT,
    binding,
    customVoiceId: "voice-sample",
    voiceId: "voice-sample",
    description: SAMPLE_TEXT,
    itemIndex: 0,
    param,
  };
}

/**
 * The value an upstream uses for a field a request leaves out; null and none are the same.
 * @param leaves - The field's shapes.
 * @returns The value, or undefined when the schema states none.
 */
function defaultIn(leaves: readonly Leaf[] | undefined): unknown {
  return leaves?.find((leaf) => leaf.default !== undefined && leaf.default !== null)?.default;
}

/**
 * Every dotted path a body writes, its objects included.
 * @param body - The body.
 * @param at - The path of the body.
 * @returns The paths.
 */
function pathsOf(body: Record<string, unknown>, at = ""): string[] {
  return Object.entries(body).flatMap(([key, value]) => {
    const path = at === "" ? key : `${at}.${key}`;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? [path, ...pathsOf(value as Record<string, unknown>, path)] : [path];
  });
}

/** One endpoint a run reaches: its schema and the fields it writes, by dotted path. */
interface Reached {
  upstream: string;
  endpoint: string;
  snapshot: SchemaSnapshot;
  written: ReadonlySet<string>;
}

/**
 * The fields a binding can ever write on its model's endpoint: its prompt field, every
 * param's field and every fixed field, with the objects they sit in.
 * @param binding - The binding.
 * @returns The dotted paths.
 */
function everWritten(binding: MediaBinding): Set<string> {
  const fields = [binding.prompt_field, ...Object.values(binding.params ?? {}).map((p) => p.field), ...Object.keys(binding.fixed ?? {})];
  return new Set(fields.filter((f): f is string => f !== undefined).flatMap((f) => f.split(".").map((_, i, parts) => parts.slice(0, i + 1).join("."))));
}

/**
 * The fields of a schema a request leaves to the upstream: at the top level, or inside an
 * object the request sends.
 * @param reached - The endpoint.
 * @returns The dotted paths.
 */
function leftOut(reached: Reached): string[] {
  return Object.keys(reached.snapshot.fields).filter((path) => {
    if (reached.written.has(path)) return false;
    const parent = path.slice(0, Math.max(0, path.lastIndexOf(".")));
    return parent === "" || reached.written.has(parent);
  });
}

/**
 * The field of another endpoint that is this one: the same dotted path, else the one field
 * whose last segment matches (`voice_setting.emotion` on one is `emotion` on another).
 * @param path - The field here.
 * @param other - The other endpoint's schema.
 * @returns Its path there, if exactly one.
 */
function counterpart(path: string, other: SchemaSnapshot): string | undefined {
  if (other.fields[path] !== undefined) return path;
  const last = path.slice(path.lastIndexOf(".") + 1);
  const same = Object.keys(other.fields).filter((p) => p.slice(p.lastIndexOf(".") + 1) === last);
  return same.length === 1 ? same[0] : undefined;
}

/**
 * Fields a reseller leaves at a default other than WaveSpeed's, or than another reseller's
 * when WaveSpeed has no such field, which the same run then reads differently there.
 * Keyed `upstream endpoint field`; each says why the two defaults give the same result.
 */
const SAME_EFFECT: Readonly<Record<string, string>> = {};

const config = shipped();
const models = new Map(catalog().models.map((m) => [m.name, m.params as Record<string, CatalogParam>]));
const cases = Object.entries(config.media.models).flatMap(([model, { upstreams }]) => upstreams.map((binding) => ({ model, binding })));
const provider = createProvider({ config, keyOf: () => "k", llmMaxRetries: 0, cleanText: (t) => t });
/** The longest prompt each catalog model takes, where it states one. */
const promptLimits = new Map(
  ["image/models.yaml", "video/models.yaml", "audio/models.yaml", "tts/models.yaml", "three_d/meshy.yaml", "three_d/hunyuan3d.yaml"]
    .flatMap((f) => yaml<{ models: { name: string; max_input_chars?: number }[] }>(`models/${f}`).models)
    .flatMap((m) => (m.max_input_chars === undefined ? [] : [[m.name, m.max_input_chars] as const])),
);

/**
 * The endpoints one binding's runs reach: the model's own, and each extra step's.
 * @param binding - The binding.
 * @returns Those with a committed snapshot.
 */
function reachedBy(binding: MediaBinding): Reached[] {
  const kind = config.upstreams[binding.upstream]?.kind;
  const own = snapshotFor(binding.upstream, binding.model_id);
  const out: Reached[] = own === undefined ? [] : [{ upstream: binding.upstream, endpoint: binding.model_id, snapshot: own, written: everWritten(binding) }];
  for (const step of binding.extra_steps ?? []) {
    const snapshot = snapshotFor(binding.upstream, step.endpoint);
    const codec = kind === undefined ? undefined : adapterOf(kind).steps[step.kind];
    if (snapshot === undefined || codec === undefined) continue;
    out.push({ upstream: binding.upstream, endpoint: `${step.kind}:${step.endpoint}`, snapshot, written: new Set(pathsOf(codec.body(sampleStep(binding, step.for_param)))) });
  }
  return out;
}

/**
 * The same endpoint of another binding of the model: its own, or its step of the same kind.
 * @param reached - The endpoint here.
 * @param binding - The other binding.
 * @returns It, if that binding reaches one.
 */
function sameOn(reached: Reached, binding: MediaBinding): Reached | undefined {
  const all = reachedBy(binding);
  const step = reached.endpoint.includes(":") ? reached.endpoint.slice(0, reached.endpoint.indexOf(":") + 1) : undefined;
  return step === undefined ? all.find((r) => !r.endpoint.includes(":")) : all.find((r) => r.endpoint.startsWith(step));
}

/**
 * Whether a reject of a binding names a field: by its upstream name, or as the list it sits in.
 * @param binding - The binding.
 * @param test - What the condition must match.
 * @returns True when some reject does.
 */
function rejectMatches(binding: MediaBinding, test: RegExp): boolean {
  return (binding.rejects ?? []).some((r) => test.test(r.when));
}

/**
 * Escape a field name for a regular expression.
 * @param name - The name.
 * @returns The escaped name.
 */
const escaped = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The string fields a binding writes from text, with the longest text our catalog lets
 * a run put there: the prompt, text params, and text sub-fields of list items.
 * @param model - The model.
 * @param binding - The binding.
 * @param snapshot - The upstream's schema.
 * @returns Each field, the list it sits in for an item sub-field, its shapes and our limit.
 */
function textFields(model: string, binding: MediaBinding, snapshot: SchemaSnapshot): { field: string; list?: string; leaves: Leaf[]; ours?: number }[] {
  const out: { field: string; list?: string; leaves: Leaf[]; ours?: number }[] = [];
  if (binding.prompt_field !== undefined) out.push({ field: binding.prompt_field, leaves: snapshot.fields[binding.prompt_field] ?? [], ours: promptLimits.get(model) });
  for (const [name, param] of Object.entries(models.get(model) ?? {})) {
    const bound = binding.params?.[name];
    if (bound === undefined) continue;
    if (param.type === "text") out.push({ field: bound.field, leaves: snapshot.fields[bound.field] ?? [], ours: param.max_chars });
    if (param.type !== "items") continue;
    const items = (snapshot.fields[bound.field] ?? []).find((leaf) => leaf.type === "array")?.items;
    for (const [sub, spec] of Object.entries(param.fields ?? {})) {
      const subField = bound.item_fields?.[sub]?.field;
      if (spec.type !== "text" || subField === undefined || items === undefined) continue;
      out.push({ field: subField, list: bound.field, leaves: items.fields[subField] ?? [], ours: spec.max_chars });
    }
  }
  return out;
}

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

  it("sends every field the upstream requires in a storyboard run, which carries shots and no prompt, or keeps the run out", async () => {
    // Shots written into the prompt (`into_prompt`) still send one; shots sent as a list replace it.
    const shots = Object.entries(params).filter(([, param]) => param.type === "items" && param.fields?.prompt !== undefined && param.into_prompt === undefined);
    if (shots.length === 0) return;
    const sample = Object.fromEntries(Object.entries(params).map(([name, param]) => [name, defaultOf(name, param, binding, snapshot)]));
    for (const [name, param] of shots) sample[name] = [sampleItem(param), sampleItem(param)];
    const missing = missingRequired(snapshot, buildBody(binding, { prompt: "", params: sample }));
    if (missing.length === 0) return;
    const run = { params: sample, prompt: "", durations: {}, placeholders: [], durationsMissing: [] };
    expect(await rejectedInput(provider.pricingRules(model), binding.upstream, run), missing.join(", ")).toBeDefined();
  });

  it("states as a reject each length bound and pattern of a text field it writes that our catalog lets a run break", () => {
    const unstated: string[] = [];
    for (const { field, list, leaves, ours } of textFields(model, binding, snapshot)) {
      const text = leaves.find((leaf) => leaf.type === "string");
      if (text === undefined) continue;
      const named = list === undefined ? `\\$length\\(\\s*${escaped(field)}\\s*\\)` : `\\b${escaped(list)}\\b.*\\$length\\(`;
      const where = list === undefined ? field : `${list}[].${field}`;
      if (text.maxLength !== undefined && (ours === undefined || ours > text.maxLength) && !rejectMatches(binding, new RegExp(`${named}[^<>]*>\\s*${text.maxLength}\\b`))) unstated.push(`${where} maxLength ${text.maxLength}`);
      if (text.minLength !== undefined && text.minLength > 1 && !rejectMatches(binding, new RegExp(`${named}[^<>]*<\\s*${text.minLength}\\b`))) unstated.push(`${where} minLength ${text.minLength}`);
      if (text.pattern !== undefined && !rejectMatches(binding, new RegExp(`\\b${escaped(list ?? field)}\\b`))) unstated.push(`${where} pattern ${text.pattern}`);
    }
    expect(unstated, unstated.join("\n")).toEqual([]);
  });

  it("states each length reject of a field at the bound its upstream's schema gives", () => {
    const stale: string[] = [];
    for (const { when } of binding.rejects ?? []) {
      const match = /^\$length\((\w+)\)\s*>\s*(\d+)$/.exec(when.trim());
      if (match === null) continue;
      const bound = (snapshot.fields[match[1]!] ?? []).find((leaf) => leaf.type === "string")?.maxLength;
      if (bound !== undefined && bound !== Number(match[2])) stale.push(`${when}: the schema says maxLength ${bound}`);
    }
    expect(stale, stale.join("\n")).toEqual([]);
  });

  it("leaves no field it does not send at a default other than WaveSpeed's, or than another reseller's where WaveSpeed has none", () => {
    if (binding.upstream === "wavespeed") return;
    const others = (config.media.models[model]?.upstreams ?? []).filter((b) => b !== binding);
    const wavespeed = others.find((b) => b.upstream === "wavespeed");
    const differ: string[] = [];
    for (const here of reachedBy(binding)) {
      const official = wavespeed === undefined ? undefined : sameOn(here, wavespeed);
      const resellers = others.filter((b) => b.upstream !== "wavespeed").map((b) => sameOn(here, b)).filter((r): r is Reached => r !== undefined);
      for (const path of leftOut(here)) {
        if (SAME_EFFECT[`${here.upstream} ${here.endpoint} ${path}`] !== undefined) continue;
        const mine = defaultIn(here.snapshot.fields[path]);
        const atOfficial = official === undefined ? undefined : counterpart(path, official.snapshot);
        const compared = atOfficial !== undefined && official !== undefined
          ? [{ there: official, path: atOfficial }]
          : resellers.flatMap((r) => {
            const at = counterpart(path, r.snapshot);
            return at === undefined ? [] : [{ there: r, path: at }];
          });
        for (const { there, path: theirs } of compared) {
          if (there.written.has(theirs)) continue;
          const other = defaultIn(there.snapshot.fields[theirs]);
          if (JSON.stringify(mine) !== JSON.stringify(other)) differ.push(`${here.endpoint} ${path}=${JSON.stringify(mine)}, ${there.upstream} ${there.endpoint} ${theirs}=${JSON.stringify(other)}`);
        }
      }
    }
    expect(differ, differ.join("\n")).toEqual([]);
  });

  it("writes its extra steps into fields their endpoints take", () => {
    for (const step of binding.extra_steps ?? []) {
      const stepSnapshot = snapshotFor(binding.upstream, step.endpoint);
      expect(stepSnapshot, `${binding.upstream}/${step.endpoint}.json`).toBeDefined();
      const codec = kind === undefined ? undefined : adapterOf(kind).steps[step.kind];
      if (stepSnapshot === undefined || codec === undefined) continue;
      const body = codec.body(sampleStep(binding, step.for_param));
      for (const [field, value] of Object.entries(body)) expect(fieldFits(stepSnapshot, field, value), `${step.kind} ${field}`).toBe(true);
      expect(missingRequired(stepSnapshot, body), step.kind).toEqual([]);
    }
  });
});
