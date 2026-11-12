// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Writes the reviewed request bodies of every fal and SandBase binding (inner#1775), which
 * `packages/provider/src/media/__tests__/reseller-body-fixture.test.ts` compares the bindings
 * against. Run from the repository root with `pnpm provider:reseller-bodies`; it calls no upstream.
 *
 * One file per binding, `packages/provider/test/fixtures/bodies/<upstream>/<model>.json`, holding
 * only runs the binding takes (`rejectedInput`): first the run with every param at its catalog
 * default (a null default left unset), every source the catalog requires (an `accepts` param not
 * marked optional) at a sample url named by the param, `https://example.com/<param>.<ext>` with
 * the extension of the kind it accepts, a sample of the first param of the model's first source
 * group when the run carries none of that group, a voice the panel fills from
 * the upstream's list at its first voice, and "sample text" in each param the panel fills from its
 * editor (`fill: editor`) without a default; every run's prompt mentions only the references that
 * run carries. Then one run per value a param's sample covers (`coveredValues`) and one per bound
 * param without a default at a sample value (a list its fewest urls, items two items, sent without a prompt
 * when they carry the shots, a text "sample text"). Every run is resolved as the application resolves
 * it (`resolvedParams`: defaults, forced values, conditions), a value outside its param's own range is
 * sent with the condition of the range that holds it, a param sent only under a condition (`when`) is
 * sent with that condition, a run its model takes no prompt for (`prompt_when`) sends none, and a run
 * the resolution changes the value of is not sent. A covered value the default run's variants miss
 * is tried on each run taken, and listed in `untaken` when none takes it. Each run is sent through
 * the media runner against a loopback stand-in for the binding's upstream (`runnerCalls`), and its
 * `body` is what the runner sent for the run's own call: the voice clone for a binding whose own
 * call is one (`reused_by`), else the generation. Each other step the runner sent is listed in
 * `steps` once, as sent on the first run that makes it (`run`, an index into `runs`). A file whose
 * binding is gone is removed.
 * Review the diff before committing it.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { CatalogBound, CatalogGate } from "../packages/provider/src/config/__tests__/shipped.js";
import type { MediaBinding } from "../packages/provider/src/config/schema.js";
import type { SampleRun } from "../packages/provider/src/media/__tests__/reseller-bodies.js";
import { isPresent } from "../packages/provider/src/pricing/estimate.js";

// The test helpers read `__dirname`, which only a CommonJS load of them has.
const load = createRequire(import.meta.url);
const { catalog, coveredValues, gateHolds, resolvedParams, shipped } = load("../packages/provider/src/config/__tests__/shipped.ts") as typeof import("../packages/provider/src/config/__tests__/shipped.js");
const { sampledCalls, takes } = load("../packages/provider/src/media/__tests__/reseller-bodies.ts") as typeof import("../packages/provider/src/media/__tests__/reseller-bodies.js");

/** One param of our catalog, as far as samples read it. */
interface CatalogParam {
  values?: (string | number | boolean)[];
  min?: number;
  max?: number;
  /** Ranges that replace `min` and `max` while their condition holds. */
  bounds?: CatalogBound[];
  /** Sent only while this holds. */
  when?: CatalogGate;
  default?: unknown;
  type?: string;
  fields?: Record<string, { values?: (string | number | boolean)[] }>;
  accepts?: string;
  /** The fewest items a list param takes. */
  min_items?: number;
  optional?: boolean;
  remote_source?: string;
  description?: string;
  /** `editor` for a param the panel always sends from its text editor. */
  fill?: string;
}

/** One sample run, before its body is built. */
type Run = Pick<SampleRun, "params" | "prompt">;

const ROOT = resolve(import.meta.dirname, "..");
const BODIES = resolve(ROOT, "packages/provider/test/fixtures/bodies");
const RESELLERS = ["fal", "sandbase"] as const;
/** The extension of a source's sample url, by the kind of file its param accepts. */
const SAMPLE_EXTENSIONS: Readonly<Record<string, string>> = { image: "png", video: "mp4", audio: "mp3" };
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
 * The value a param without a default is sampled at; a source's url names its param, so a step reading another shows.
 * @param name - The param's name.
 * @param param - The catalog's param.
 * @returns The value.
 */
function sampleOf(name: string, param: CatalogParam): unknown {
  const url = `https://example.com/${name}.${(param.accepts === undefined ? undefined : SAMPLE_EXTENSIONS[param.accepts]) ?? "png"}`;
  if (param.type === "items") return [sampleItem(param), sampleItem(param)];
  if (param.type === "list") return Array<string>(param.min_items ?? 1).fill(url);
  if (param.accepts !== undefined || /\bURL\b/.test(param.description ?? "")) return url;
  return SAMPLE_TEXT;
}

/**
 * The prompt the samples send: a sentence, and one reference to each param the binding has a mention template for
 * that the run carries.
 * @param model - The model.
 * @param binding - The binding.
 * @param params - The run's params.
 * @returns The prompt, empty for a binding that takes none or a run its model takes none for (`prompt_when`).
 */
function promptOf(model: string, binding: MediaBinding, params: Record<string, unknown>): string {
  if (binding.prompt_field === undefined) return "";
  const when = entries.get(model)?.prompt_when as CatalogGate | undefined;
  if (when !== undefined && !gateHolds(when, params)) return "";
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
const entries = new Map(catalog().models.map((m) => [m.name, m]));
const offered = new Map([...entries].map(([name, m]) => [name, m.params as Record<string, CatalogParam>]));
const sourceGroups = new Map([...entries].map(([name, m]) => [name, m.source_groups ?? []] as const));

/**
 * The params that make a value of a number param reachable: for a value outside its own range, the condition of the
 * first conditional range that holds it, its switch on and its params at their values.
 * @param value - The value.
 * @param param - The catalog's param.
 * @returns The params to set with it.
 */
function reaching(value: unknown, param: CatalogParam | undefined): Record<string, unknown> {
  if (typeof value !== "number" || param?.min === undefined || param.max === undefined || (value >= param.min && value <= param.max)) return {};
  const bound = param.bounds?.find((b) => value >= (b.min ?? param.min!) && value <= (b.max ?? param.max!));
  return bound === undefined ? {} : satisfying(bound.when);
}

/**
 * The params that make a condition hold: its switch on and its params at their values.
 * @param when - The condition, if any.
 * @returns The params to set.
 */
function satisfying(when: CatalogGate | undefined): Record<string, unknown> {
  return when === undefined ? {} : { ...(when.flag_on === undefined ? {} : { [when.flag_on]: true }), ...when.equals };
}

/**
 * The run with one param set, resolved as the application resolves it (`resolvedParams`), its prompt built from its own
 * params: without a prompt when the param's items carry the shots.
 * @param model - The model.
 * @param binding - The binding.
 * @param base - The run it changes.
 * @param name - The param.
 * @param value - Its value.
 * @param param - The catalog's param.
 * @returns The run, or undefined when the application would not send the value (a forced value replaces it or a condition drops it).
 */
function withParam(model: string, binding: MediaBinding, base: Run, name: string, value: unknown, param: CatalogParam | undefined): Run | undefined {
  const set = shotsAddingUp(value, param, base.params);
  const params = resolvedParams(entries.get(model)!, { ...base.params, ...reaching(value, param), ...satisfying(param?.when), [name]: set });
  if (JSON.stringify(params[name]) !== JSON.stringify(set)) return undefined;
  return { params, prompt: carriesShots(param) ? "" : promptOf(model, binding, params) };
}

/**
 * Shots whose seconds add up to the run's own param of that name, as the storyboard keeps them (`totalParam`): the last
 * shot takes what the others leave.
 * @param value - The param's value.
 * @param param - The catalog's param.
 * @param params - The run's other params.
 * @returns The value, its last shot's seconds set when the shots carry seconds the run totals.
 */
function shotsAddingUp(value: unknown, param: CatalogParam | undefined, params: Record<string, unknown>): unknown {
  const seconds = Object.keys(param?.fields ?? {}).find((field) => field !== "prompt");
  const total = seconds === undefined ? undefined : params[seconds];
  if (!carriesShots(param) || !Array.isArray(value) || value.length === 0 || typeof total !== "number") return value;
  const shots = value as Record<string, unknown>[];
  const others = shots.slice(0, -1).reduce((sum, shot) => sum + Number(shot[seconds!]), 0);
  return [...shots.slice(0, -1), { ...shots.at(-1), [seconds!]: total - others }];
}

const written = new Set<string>();
for (const [model, { upstreams: bindings }] of Object.entries(config.media.models)) {
  for (const binding of bindings.filter((b) => (RESELLERS as readonly string[]).includes(b.upstream))) {
    const params = offered.get(model) ?? {};
    const bound = Object.keys(binding.params ?? {});
    const defaults = Object.fromEntries(Object.entries(params).map(([name, p]) => [name, p.default]).filter(([, v]) => v !== undefined && v !== null));
    // A source the catalog requires, a voice the panel fills from the upstream's list, and the text of a param the panel
    // always sends from its editor are in every run the application sends.
    const required: Record<string, unknown> = {};
    for (const [name, p] of Object.entries(params)) {
      if (defaults[name] !== undefined) continue;
      if (p.fill === "editor") required[name] = SAMPLE_TEXT;
      if (p.optional === true) continue;
      if (p.accepts !== undefined) required[name] = sampleOf(name, p);
      else if (p.remote_source !== undefined) {
        const voice = coveredValues(name, p, binding)[0];
        if (voice !== undefined) required[name] = voice;
      }
    }
    // A run the application sends carries material for the model's first source group.
    const group = sourceGroups.get(model)?.[0];
    const seeded = group?.any_of[0];
    if (group !== undefined && seeded !== undefined && params[seeded] !== undefined && !group.any_of.some((p) => isPresent(defaults[p] ?? required[p]))) {
      required[seeded] = sampleOf(seeded, params[seeded]);
    }
    const firstParams = resolvedParams(entries.get(model)!, { ...defaults, ...required });
    const first: Run = { params: firstParams, prompt: promptOf(model, binding, firstParams) };
    const candidates: (Run | undefined)[] = [first];
    for (const name of bound) {
      const values = coveredValues(name, params[name], binding);
      for (const value of values) if (String(value) !== String(firstParams[name])) candidates.push(withParam(model, binding, first, name, value, params[name]));
      if (values.length === 0 && firstParams[name] === undefined && params[name] !== undefined) candidates.push(withParam(model, binding, first, name, sampleOf(name, params[name]), params[name]));
    }
    const runs: Run[] = [];
    for (const run of candidates) if (run !== undefined && (await takes(model, binding, run.params, run.prompt))) runs.push(run);
    if (runs.length === 0) throw new Error(`${model} on ${binding.upstream}: the binding takes none of the sample runs`);
    // A value no run above carries is tried on each run taken, and listed as untaken when every one refuses it.
    const untaken: { param: string; value: unknown }[] = [];
    for (const name of bound) {
      const values = coveredValues(name, params[name], binding);
      const wanted = values.length === 0 && !runs.some((r) => r.params[name] !== undefined && r.params[name] !== null) && params[name] !== undefined ? [sampleOf(name, params[name])] : values;
      for (const value of wanted) {
        if (runs.some((r) => r.params[name] !== undefined && r.params[name] !== null && String(r.params[name]) === String(value))) continue;
        let taken: Run | undefined;
        for (const run of [...runs]) {
          const trial = withParam(model, binding, run, name, value, params[name]);
          if (trial !== undefined && (await takes(model, binding, trial.params, trial.prompt))) {
            taken = trial;
            break;
          }
        }
        if (taken !== undefined) runs.push(taken);
        else untaken.push({ param: name, value });
      }
    }
    const { runs: samples, steps } = await sampledCalls(model, binding, runs);
    const path = resolve(BODIES, binding.upstream, `${model}.json`);
    writeJson(path, {
      model,
      upstream: binding.upstream,
      model_id: binding.model_id,
      runs: samples,
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
