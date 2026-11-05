// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Writes the reviewed request bodies of every fal and SandBase binding (inner#1775), which
 * `packages/provider/src/media/__tests__/reseller-body-fixture.test.ts` compares the bindings
 * against. Run from the repository root with `pnpm provider:reseller-bodies`; it calls no upstream.
 *
 * One file per binding, `packages/provider/test/fixtures/bodies/<upstream>/<model>.json`, holding
 * only runs the binding takes (`rejectedInput`): first the run with every param at its catalog
 * default (a null default left unset), every source the catalog requires (an `accepts` param not
 * marked optional) at a sample url and a voice the panel fills from the upstream's list at its first voice, its prompt mentioning only the references that run carries, then one run per value a param's sample covers
 * (`coveredValues`) and one per bound param without a default at a sample value (a list one url,
 * items two items, sent without a prompt when they carry the shots, a text "sample text"). A covered
 * value the default run's variants miss is tried on each run taken, and listed in `untaken` when none takes it. A param an extra step serves carries the id that step
 * answers in `ids`, as the runner writes it; a binding whose own call is a voice clone
 * (`reused_by`) shows the body of that call as the voice step writes it. Each extra step's body is
 * built by its codec with one fixed context. A file whose binding is gone is removed. Review the
 * diff before committing it.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { MediaBinding } from "../packages/provider/src/config/schema.js";
import { adapterOf } from "../packages/provider/src/media/adapters.js";
import type { SampleRun } from "../packages/provider/src/media/__tests__/reseller-bodies.js";
import { isPresent } from "../packages/provider/src/pricing/estimate.js";

// The test helpers read `__dirname`, which only a CommonJS load of them has.
const load = createRequire(import.meta.url);
const { catalog, coveredValues, shipped } = load("../packages/provider/src/config/__tests__/shipped.ts") as typeof import("../packages/provider/src/config/__tests__/shipped.js");
const { SAMPLE_VOICE_ID, firstBody, takes } = load("../packages/provider/src/media/__tests__/reseller-bodies.ts") as typeof import("../packages/provider/src/media/__tests__/reseller-bodies.js");

/** One param of our catalog, as far as samples read it. */
interface CatalogParam {
  values?: (string | number | boolean)[];
  min?: number;
  max?: number;
  default?: unknown;
  type?: string;
  fields?: Record<string, { values?: (string | number | boolean)[] }>;
  accepts?: string;
  optional?: boolean;
  remote_source?: string;
  description?: string;
}

/** One sample run, before its body is built. */
type Run = Pick<SampleRun, "params" | "prompt">;

const ROOT = resolve(import.meta.dirname, "..");
const BODIES = resolve(ROOT, "packages/provider/test/fixtures/bodies");
const RESELLERS = ["fal", "sandbase"] as const;
const SAMPLE_URL = "https://example.com/sample.png";
const SAMPLE_TEXT = "sample text";
const SAMPLE_WORD = "sample";
const SAMPLE_PROMPT = "a red fox running through fresh snow at dawn";

/**
 * One sample item of an `items` param from its fields.
 * @param param - The param.
 * @returns The item.
 */
function sampleItem(param: CatalogParam): Record<string, unknown> {
  return Object.fromEntries(Object.entries(param.fields ?? {}).map(([sub, f]) => [sub, f.values?.[0] ?? SAMPLE_WORD]));
}

/**
 * Whether an `items` param's items carry the shots, each with its own prompt; a run carrying them sends no prompt of its own.
 * @param param - The param.
 * @returns True for such a param.
 */
function carriesShots(param: CatalogParam | undefined): boolean {
  return param?.type === "items" && param.fields?.prompt !== undefined;
}

/**
 * The value a param without a default is sampled at.
 * @param param - The catalog's param.
 * @returns The value.
 */
function sampleOf(param: CatalogParam): unknown {
  if (param.type === "items") return [sampleItem(param), sampleItem(param)];
  if (param.type === "list") return [SAMPLE_URL];
  if (param.accepts !== undefined || /\bURL\b/.test(param.description ?? "")) return SAMPLE_URL;
  return SAMPLE_TEXT;
}

/**
 * The prompt the samples send: a sentence, and one reference to each param the binding has a mention template for
 * that the run carries.
 * @param binding - The binding.
 * @param params - The run's params.
 * @returns The prompt, empty for a binding that takes none.
 */
function promptOf(binding: MediaBinding, params: Record<string, unknown>): string {
  if (binding.prompt_field === undefined) return "";
  const carried = Object.keys(binding.mentions ?? {}).filter((param) => isPresent(params[param]));
  return [SAMPLE_PROMPT, ...carried.map((param) => `<<ref:${param}:1>>`)].join(" ");
}

/**
 * Write a JSON file, creating its directory.
 * @param path - The absolute path.
 * @param content - The content.
 */
function writeJson(path: string, content: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`);
}

const config = shipped();
const offered = new Map(catalog().models.map((m) => [m.name, m.params as Record<string, CatalogParam>]));

/**
 * The run with one param set: without a prompt when the param's items carry the shots.
 * @param base - The run it changes.
 * @param name - The param.
 * @param value - Its value.
 * @param param - The catalog's param.
 * @returns The run.
 */
function withParam(base: Run, name: string, value: unknown, param: CatalogParam | undefined): Run {
  return { params: { ...base.params, [name]: value }, prompt: carriesShots(param) ? "" : base.prompt };
}

const written = new Set<string>();
for (const [model, { upstreams: bindings }] of Object.entries(config.media.models)) {
  for (const binding of bindings.filter((b) => (RESELLERS as readonly string[]).includes(b.upstream))) {
    const params = offered.get(model) ?? {};
    const bound = Object.keys(binding.params ?? {});
    const defaults = Object.fromEntries(Object.entries(params).map(([name, p]) => [name, p.default]).filter(([, v]) => v !== undefined && v !== null));
    // A source the catalog requires, and a voice the panel fills from the upstream's list, are in every run the application sends.
    const required: Record<string, unknown> = {};
    for (const [name, p] of Object.entries(params)) {
      if (defaults[name] !== undefined || p.optional === true) continue;
      if (p.accepts !== undefined) required[name] = sampleOf(p);
      else if (p.remote_source !== undefined && coveredValues(name, p, binding)[0] !== undefined) required[name] = coveredValues(name, p, binding)[0];
    }
    const firstParams = { ...defaults, ...required };
    const first: Run = { params: firstParams, prompt: promptOf(binding, firstParams) };
    const candidates: Run[] = [first];
    for (const name of bound) {
      const values = coveredValues(name, params[name], binding);
      for (const value of values) if (String(value) !== String(firstParams[name])) candidates.push(withParam(first, name, value, params[name]));
      if (values.length === 0 && firstParams[name] === undefined && params[name] !== undefined) candidates.push(withParam(first, name, sampleOf(params[name]), params[name]));
    }
    const runs: Run[] = [];
    for (const run of candidates) if (await takes(model, binding, run.params, run.prompt)) runs.push(run);
    if (runs.length === 0) throw new Error(`${model} on ${binding.upstream}: the binding takes none of the sample runs`);
    // A value no run above carries is tried on each run taken, and listed as untaken when every one refuses it.
    const base = runs[0]!;
    const untaken: { param: string; value: unknown }[] = [];
    for (const name of bound) {
      const values = coveredValues(name, params[name], binding);
      const wanted = values.length === 0 && !runs.some((r) => r.params[name] !== undefined && r.params[name] !== null) && params[name] !== undefined ? [sampleOf(params[name])] : values;
      for (const value of wanted) {
        if (runs.some((r) => r.params[name] !== undefined && r.params[name] !== null && String(r.params[name]) === String(value))) continue;
        let taken: Run | undefined;
        for (const run of [...runs]) {
          const trial = withParam(run, name, value, params[name]);
          if (await takes(model, binding, trial.params, trial.prompt)) {
            taken = trial;
            break;
          }
        }
        if (taken !== undefined) runs.push(taken);
        else untaken.push({ param: name, value });
      }
    }
    const kind = config.upstreams[binding.upstream]!.kind;
    const served = (binding.extra_steps ?? []).filter((s) => s.for_param !== undefined);
    const steps = (binding.extra_steps ?? []).map((step) => {
      const codec = adapterOf(kind).steps[step.kind as keyof ReturnType<typeof adapterOf>["steps"]];
      if (codec === undefined) throw new Error(`${model} on ${binding.upstream}: no ${step.kind} step codec`);
      const context: { source: string; params: Record<string, unknown>; prompt: string; customVoiceId: string; voiceId: string; itemIndex: number | null; description?: string; param?: string } = {
        source: SAMPLE_URL,
        params: base.params,
        prompt: base.prompt,
        customVoiceId: SAMPLE_VOICE_ID,
        voiceId: "voice-sample",
        itemIndex: step.per_item === true ? 0 : null,
        ...(step.kind === "element" ? { description: SAMPLE_TEXT } : {}),
        ...(step.for_param === undefined ? {} : { param: step.for_param }),
      };
      const body = codec.body({ ...context, source: () => context.source, binding, description: context.description, param: context.param });
      return { kind: step.kind, endpoint: step.endpoint, context, body };
    });
    const path = resolve(BODIES, binding.upstream, `${model}.json`);
    writeJson(path, {
      model,
      upstream: binding.upstream,
      model_id: binding.model_id,
      runs: runs.map((run) => {
        const ids = Object.fromEntries(served.filter((s) => run.params[s.for_param!] !== undefined && run.params[s.for_param!] !== null).map((s) => [s.for_param!, `${s.kind}-id`]));
        const sample = { params: run.params, prompt: run.prompt, ...(Object.keys(ids).length === 0 ? {} : { ids }) };
        return { ...sample, body: firstBody(binding, { ...sample, body: {} }) };
      }),
      ...(untaken.length === 0 ? {} : { untaken }),
      steps,
    });
    written.add(path);
  }
}

let removed = 0;
for (const upstream of RESELLERS) {
  const dir = resolve(BODIES, upstream);
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const path = resolve(dir, file);
    if (written.has(path)) continue;
    rmSync(path);
    removed += 1;
  }
}
process.stdout.write(`${written.size} body samples written to ${BODIES}, ${removed} stale ones removed\n`);
