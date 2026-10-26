// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Freezes what today's code answers, so the provider package can prove it
 * answers the same without importing today's code (inner#1743, design 13.2).
 *
 * Run from the repository root with `pnpm exec tsx scripts/provider-fixtures.ts`.
 * It reads every catalog model's WaveSpeed pricing contracts, prices a set of
 * upstream field values per contract with shared's `upstreamPriceUsd`, and
 * writes the cases to `packages/provider/test/fixtures/upstream-price.json`.
 * It also builds, for a set of param values per catalog and 3D model, our
 * params as the application layer hands them to provider and the WaveSpeed
 * body today's worker sends for them, into
 * `packages/provider/test/fixtures/upstream-body.json`. The provider package
 * reads those files only. This script imports code that the migration deletes,
 * so it lives outside the package and is removed with it. Build
 * `@breatic/shared` first: the worker code it imports reads shared's `dist`.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { upstreamPriceUsd } from "../packages/shared/src/pricing/upstream-price.js";
import { completeEntries, isPresent, joinSlotFiles } from "../packages/shared/dist/index.js";
import { upstreamBody } from "../packages/worker/src/providers/upstream-body.js";
import minimaxSpeech from "../packages/worker/src/providers/families/minimax-speech.js";
import nanoBananaRelight from "../packages/worker/src/providers/families/nano-banana-relight.js";

interface RawPricing { base_price: number; formula: string; discount_rate: number }
interface RawParam {
  upstream?: string;
  default?: unknown;
  values?: unknown[];
  type?: string;
  accepts?: string;
  min_items?: number;
  max_items?: number;
  fields?: Record<string, { type?: string; values?: unknown[] }>;
  replaces?: string;
}
interface RawModel {
  name: string;
  takes_prompt?: boolean;
  prompt_upstream?: string;
  params?: Record<string, RawParam>;
  providers?: { name: string; pricing: RawPricing }[];
  extra_steps?: { kind?: string; for_param?: string; pricing: RawPricing }[];
  reused_by?: string;
}

/** One frozen case: a contract, the fields it was evaluated on, and what today's code answered. */
interface PriceCase {
  model: string;
  /** Key into the file's `contracts`. */
  contract: string;
  fields: Record<string, unknown>;
  durations: Record<string, number[]>;
  usd: number | null;
}

/** A contract in the evaluator's shape. */
interface Contract { basePrice: number; formula: string; discountRate: number }

const ROOT = resolve(import.meta.dirname, "..");
const MODALITIES = ["image", "video", "audio", "tts"];
const PROMPTS = ["", "a red fox running through fresh snow at dawn"];
const CLIP_SECONDS = [[5], [12], [3, 9]];

/**
 * Today's pricing contract in the evaluator's shape.
 * @param raw - The contract as the catalog writes it.
 * @returns The contract.
 */
function contractOf(raw: RawPricing): Contract {
  return { basePrice: raw.base_price, formula: raw.formula, discountRate: raw.discount_rate };
}

/**
 * The field values a model sends with every param at its default.
 * @param model - The catalog entry.
 * @returns Upstream field name to value.
 */
function defaults(model: RawModel): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(model.params ?? {})) {
    fields[spec.upstream ?? name] = spec.default ?? (spec.type === "list" ? [] : null);
  }
  return fields;
}

/**
 * Every field set to price: the defaults, then each offered value of each param in turn,
 * with prompt and clip-length samples only where the formula reads them.
 * @param model - The catalog entry.
 * @param formula - The contract's formula.
 * @returns The field sets and clip lengths.
 */
function samples(model: RawModel, formula: string): { fields: Record<string, unknown>; durations: Record<string, number[]> }[] {
  const base = defaults(model);
  const variants: Record<string, unknown>[] = [base];
  for (const [name, spec] of Object.entries(model.params ?? {})) {
    for (const value of spec.values ?? []) variants.push({ ...base, [spec.upstream ?? name]: value });
  }
  const promptField = model.prompt_upstream ?? "prompt";
  const listFields = Object.entries(model.params ?? {}).map(([name, spec]) => spec.upstream ?? name);
  const out: { fields: Record<string, unknown>; durations: Record<string, number[]> }[] = [];
  for (const variant of variants) {
    const prompts = model.takes_prompt === false ? [""] : formula.includes("$length") ? PROMPTS : [PROMPTS[1]!];
    for (const prompt of prompts) {
      for (const clips of formula.includes("get_duration") ? CLIP_SECONDS : [[5]]) {
        const durations = Object.fromEntries(listFields.map((field) => [field, clips]));
        out.push({ fields: { ...variant, ...(model.takes_prompt === false ? {} : { [promptField]: prompt }) }, durations });
      }
    }
  }
  return out;
}

/**
 * Price one field set with today's evaluator; a formula that refuses the input is recorded as null.
 * @param pricing - The contract.
 * @param fields - The field values.
 * @param durations - Clip lengths per field.
 * @returns USD, or null when today's code throws.
 */
async function priceOrNull(pricing: Contract, fields: Record<string, unknown>, durations: Record<string, number[]>): Promise<number | null> {
  try {
    return await upstreamPriceUsd(pricing, fields, durations);
  } catch {
    return null;
  }
}

const cases: PriceCase[] = [];
const contracts: Record<string, Contract> = {};
for (const modality of MODALITIES) {
  const file = parse(readFileSync(resolve(ROOT, `config/models/${modality}/models.yaml`), "utf8")) as { models: RawModel[] };
  for (const model of file.models) {
    const contracts: [string, RawPricing][] = [
      ...(model.providers ?? []).map((p): [string, RawPricing] => [`model:${p.name}`, p.pricing]),
      ...(model.extra_steps ?? []).map((s, i): [string, RawPricing] => [`step:${i}:${s.kind ?? "step"}`, s.pricing]),
    ];
    for (const [contract, raw] of contracts) {
      const pricing = contractOf(raw);
      const id = `${model.name}#${contract}`;
      contracts[id] = pricing;
      const seen = new Set<string>();
      for (const { fields, durations } of samples(model, pricing.formula)) {
        const key = JSON.stringify([fields, durations]);
        if (seen.has(key)) continue;
        seen.add(key);
        cases.push({ model: model.name, contract: id, fields, durations, usd: await priceOrNull(pricing, fields, durations) });
      }
    }
  }
}

const out = resolve(ROOT, "packages/provider/test/fixtures/upstream-price.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ contracts, cases })}\n`);
process.stdout.write(`${cases.length} cases, ${cases.filter((c) => c.usd === null).length} refused, written to ${out}\n`);

/** One frozen body case: our prepared params and prompt, and the body today's worker sends. */
interface BodyCase {
  model: string;
  /** "catalog" models run through `upstreamBody`; "three_d" models send every param as it is, plus the prompt. */
  kind: "catalog" | "three_d";
  params: Record<string, unknown>;
  prompt: string;
  body: Record<string, unknown>;
}

/**
 * Families whose prompt or params the application layer prepares (design 7.1):
 * the params they consume never reach provider. nano-banana's list is copied from
 * `packages/worker/src/providers/families/nano-banana.ts` (`CONSUMES`), whose
 * module needs a live LLM to load.
 */
const APP_FAMILIES = new Map<string, { consumes: ReadonlySet<string>; prepare?: typeof nanoBananaRelight.prepare }>([
  ["nano-banana-2", { consumes: new Set(["enable_camera", "camera", "lens", "focal_length", "aperture"]) }],
  ...[...nanoBananaRelight.MODELS].map((name) => [name, { consumes: nanoBananaRelight.CONSUMES, prepare: nanoBananaRelight.prepare }] as const),
]);

/**
 * A filled value for a param the canvas or the panel fills by hand.
 * @param name - The param.
 * @param spec - Its declaration.
 * @returns The value, or undefined for a param that takes none of these shapes.
 */
function filled(name: string, spec: RawParam): unknown {
  const extension = { image: "png", audio: "mp3", video: "mp4" }[spec.accepts ?? ""] ?? "bin";
  const url = (i: number): string => `https://cdn.example/${name}-${i}.${extension}`;
  const count = Math.max(1, Math.min(spec.max_items ?? 2, Math.max(spec.min_items ?? 1, 2)));
  if (spec.accepts !== undefined) return spec.type === "list" ? Array.from({ length: count }, (_, i) => url(i + 1)) : url(1);
  if (spec.type === "items") {
    return Array.from({ length: count }, (_, i) =>
      Object.fromEntries(Object.entries(spec.fields ?? {}).map(([field, f]) => [field, f.values?.[0] ?? `${field} ${i + 1}`])),
    );
  }
  if (spec.type === "text") return `some ${name}`;
  return undefined;
}

/**
 * The param sets to build bodies for: the defaults, the defaults with every
 * source, list, item and text param filled, and each offered value in turn.
 * A param an extra step serves stays at its default: the model's own call
 * sends what that step answered in its place, which the runner tests cover.
 * @param model - The catalog entry.
 * @returns The param sets.
 */
function bodySamples(model: RawModel): Record<string, unknown>[] {
  const base = ourDefaults(model);
  const everything: Record<string, unknown> = { ...base };
  const served = new Set((model.extra_steps ?? []).map((step) => step.for_param).filter((name) => name !== undefined));
  for (const [name, spec] of Object.entries(model.params ?? {})) {
    if (served.has(name)) continue;
    const value = filled(name, spec);
    if (value !== undefined) everything[name] = value;
  }
  const out = [base, everything];
  for (const [name, spec] of Object.entries(model.params ?? {})) {
    for (const value of spec.values ?? []) out.push({ ...everything, [name]: value });
  }
  return out;
}

/**
 * Today's catalog defaults keyed by our param names (not upstream names).
 * @param model - The catalog entry.
 * @returns Param name to default.
 */
function ourDefaults(model: RawModel): Record<string, unknown> {
  return Object.fromEntries(Object.entries(model.params ?? {}).map(([name, spec]) => [name, spec.default ?? (spec.type === "list" ? [] : null)]));
}

/**
 * Our params as the application layer hands them to provider: slots joined
 * into their pools, item lists completed, empty values dropped, a param a
 * filled one replaces dropped, and an application family's preparation applied.
 * @param model - The catalog entry.
 * @param given - The params the reader set.
 * @param written - The reader's prompt.
 * @returns The prepared params and prompt.
 */
async function prepare(model: RawModel, given: Record<string, unknown>, written: string): Promise<{ params: Record<string, unknown>; prompt: string }> {
  const declared = (model.params ?? {}) as Parameters<typeof joinSlotFiles>[0];
  const family = APP_FAMILIES.get(model.name);
  const joined = joinSlotFiles(declared, given, written);
  const params: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(model.params ?? {})) {
    if (family?.consumes.has(name)) continue;
    const value = spec.type === "items" ? completeEntries(joined.params[name], spec.fields ?? {}) : joined.params[name];
    if (isPresent(value)) params[name] = value;
  }
  for (const name of Object.keys(params)) {
    const replaced = model.params?.[name]?.replaces;
    if (replaced !== undefined) delete params[replaced];
  }
  if (family?.prepare === undefined) return { params, prompt: joined.prompt };
  const prepared = await family.prepare(joined.prompt, given, new AbortController().signal);
  return { params: { ...params, ...prepared.fields }, prompt: prepared.prompt };
}

/**
 * The body today's worker sends for one catalog param set.
 * @param model - The catalog entry.
 * @param given - The params the reader set.
 * @param written - The reader's prompt.
 * @returns The body.
 */
async function todayBody(model: RawModel, given: Record<string, unknown>, written: string): Promise<Record<string, unknown>> {
  const entry = model as unknown as Parameters<typeof upstreamBody>[0];
  const app = APP_FAMILIES.get(model.name);
  if (app !== undefined) {
    const prepared = app.prepare ? await app.prepare(written, given, new AbortController().signal) : { prompt: written, fields: {} };
    return { ...upstreamBody(entry, given, prepared.prompt, app.consumes), ...prepared.fields };
  }
  if (minimaxSpeech.MODELS.has(model.name)) {
    const prepared = await minimaxSpeech.prepare(written, given, new AbortController().signal);
    return { ...upstreamBody(entry, given, prepared.prompt, minimaxSpeech.CONSUMES), ...prepared.fields };
  }
  return upstreamBody(entry, given, written);
}

const bodyCases: BodyCase[] = [];
for (const modality of MODALITIES) {
  const file = parse(readFileSync(resolve(ROOT, `config/models/${modality}/models.yaml`), "utf8")) as { models: RawModel[] };
  for (const model of file.models) {
    const seen = new Set<string>();
    for (const sample of bodySamples(model)) {
      const given = sample;
      // A clone's own call takes no prompt; the speech after it does.
      const written = model.takes_prompt === false || model.reused_by !== undefined ? "" : PROMPTS[1]!;
      const key = JSON.stringify(given);
      if (seen.has(key)) continue;
      seen.add(key);
      const prepared = await prepare(model, given, written);
      bodyCases.push({ model: model.name, kind: "catalog", ...prepared, body: await todayBody(model, given, written) });
    }
  }
}
for (const family of ["meshy", "hunyuan3d"]) {
  const file = parse(readFileSync(resolve(ROOT, `config/models/three_d/${family}.yaml`), "utf8")) as { models: RawModel[] };
  for (const model of file.models) {
    const seen = new Set<string>();
    for (const given of bodySamples(model)) {
      const key = JSON.stringify(given);
      if (seen.has(key)) continue;
      seen.add(key);
      const params = Object.fromEntries(Object.entries(given).filter(([, v]) => v != null));
      const prompt = model.takes_prompt === false ? "" : PROMPTS[1]!;
      bodyCases.push({ model: model.name, kind: "three_d", params, prompt, body: { ...params, ...(prompt ? { prompt } : {}) } });
    }
  }
}
const bodyOut = resolve(ROOT, "packages/provider/test/fixtures/upstream-body.json");
writeFileSync(bodyOut, `${JSON.stringify({ cases: bodyCases })}\n`);
process.stdout.write(`${bodyCases.length} body cases written to ${bodyOut}\n`);

