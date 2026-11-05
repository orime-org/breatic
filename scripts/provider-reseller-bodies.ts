// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Writes the reviewed request bodies of every fal and SandBase binding (inner#1775), which
 * `packages/provider/src/media/__tests__/reseller-body-fixture.test.ts` compares the bindings
 * against. Run from the repository root with `pnpm provider:reseller-bodies`; it calls no upstream.
 *
 * One file per binding, `packages/provider/test/fixtures/bodies/<upstream>/<model>.json`: the
 * body of a run with every param at its catalog default (a param without one at a sample value),
 * one run per value a param's sample must cover (each supported offered value, a range's two ends,
 * each voice of a voice map), and the body of each extra step built by its codec with one fixed
 * context. A file whose binding is gone is removed. Review the diff before committing it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import type { MediaBinding, ProviderConfigInput } from "../packages/provider/src/config/schema.js";
import { adapterOf } from "../packages/provider/src/media/adapters.js";
import { buildBody } from "../packages/provider/src/media/body.js";

/** One param of our catalog, as far as samples read it. */
interface CatalogParam {
  values?: (string | number | boolean)[];
  min?: number;
  max?: number;
  default?: unknown;
  type?: string;
  fields?: Record<string, { values?: (string | number | boolean)[] }>;
  accepts?: string;
}

const ROOT = resolve(import.meta.dirname, "..");
const BODIES = resolve(ROOT, "packages/provider/test/fixtures/bodies");
const MODALITIES = ["image", "video", "audio", "tts", "three_d"] as const;
const CATALOG = ["image/models.yaml", "video/models.yaml", "audio/models.yaml", "tts/models.yaml", "three_d/meshy.yaml", "three_d/hunyuan3d.yaml"];
const RESELLERS = ["fal", "sandbase"] as const;
const SAMPLE_URL = "https://example.com/sample.png";
const SAMPLE_TEXT = "sample text";
const SAMPLE_WORD = "sample";
const SAMPLE_PROMPT = "a red fox running through fresh snow at dawn";

/**
 * Read a yaml file under the repository's `config/`.
 * @param path - The path below `config/`.
 * @returns Its content.
 */
function yaml<T>(path: string): T {
  return parse(readFileSync(resolve(ROOT, "config", path), "utf8")) as T;
}

/**
 * One sample item of an `items` param from its fields.
 * @param param - The param.
 * @returns The item.
 */
function sampleItem(param: CatalogParam): Record<string, unknown> {
  return Object.fromEntries(Object.entries(param.fields ?? {}).map(([sub, f]) => [sub, f.values?.[0] ?? SAMPLE_WORD]));
}

/**
 * The value a sample run gives a param: its catalog default, else a sample of its kind.
 * @param param - The catalog's param.
 * @returns The value.
 */
function defaultOf(param: CatalogParam): unknown {
  if (param.default !== undefined && param.default !== null) return param.default;
  if (param.type === "items") return [sampleItem(param), sampleItem(param)];
  if (param.type === "list") return [SAMPLE_URL];
  if (param.accepts !== undefined) return SAMPLE_URL;
  if (param.values !== undefined && param.values.length > 0) return param.values[0];
  if (param.min !== undefined) return param.min;
  return SAMPLE_TEXT;
}

/**
 * The values of a param a binding's sample covers: each offered value it supports, a range's ends, a voice map's voices.
 * @param name - The param.
 * @param param - The catalog's param.
 * @param binding - The binding.
 * @returns The values.
 */
function coveredValues(name: string, param: CatalogParam | undefined, binding: MediaBinding): unknown[] {
  const voices = binding.voice_map?.[name];
  let values: unknown[] = voices !== undefined ? Object.keys(voices) : param?.values ?? (param?.min !== undefined && param.max !== undefined ? [param.min, param.max] : []);
  const supported = binding.params?.[name]?.supported;
  if (supported !== undefined) values = values.filter((v) => supported.includes(v as string | number | boolean));
  return values;
}

/**
 * The prompt the samples send: a sentence, and one reference to each param the binding has a mention template for.
 * @param binding - The binding.
 * @returns The prompt, empty for a binding that takes none.
 */
function promptOf(binding: MediaBinding): string {
  if (binding.prompt_field === undefined) return "";
  return [SAMPLE_PROMPT, ...Object.keys(binding.mentions ?? {}).map((param) => `<<ref:${param}:1>>`)].join(" ");
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

const upstreams = yaml<{ upstreams: ProviderConfigInput["upstreams"] }>("provider/upstreams.yaml").upstreams;
const models: Record<string, { upstreams: MediaBinding[] }> = {};
for (const modality of MODALITIES) Object.assign(models, yaml<{ models: Record<string, { upstreams: MediaBinding[] }> }>(`provider/media/${modality}.yaml`).models);
const catalog = new Map(CATALOG.flatMap((file) => yaml<{ models: { name: string; params?: Record<string, CatalogParam> }[] }>(`models/${file}`).models)
  .map((m) => [m.name, m.params ?? {}]));

const written = new Set<string>();
for (const [model, { upstreams: bindings }] of Object.entries(models)) {
  for (const binding of bindings.filter((b) => (RESELLERS as readonly string[]).includes(b.upstream))) {
    const params = catalog.get(model) ?? {};
    const prompt = promptOf(binding);
    const defaults = Object.fromEntries(Object.entries(params).map(([name, param]) => [name, defaultOf(param)]));
    const runs = [defaults];
    for (const name of Object.keys(binding.params ?? {})) {
      for (const value of coveredValues(name, params[name], binding)) {
        if (String(value) !== String(defaults[name])) runs.push({ ...defaults, [name]: value });
      }
    }
    const kind = upstreams[binding.upstream]!.kind;
    const steps = (binding.extra_steps ?? []).map((step) => {
      const codec = adapterOf(kind).steps[step.kind as keyof ReturnType<typeof adapterOf>["steps"]];
      if (codec === undefined) throw new Error(`${model} on ${binding.upstream}: no ${step.kind} step codec`);
      const context = {
        source: SAMPLE_URL,
        params: defaults,
        prompt,
        customVoiceId: "BreaticSample",
        voiceId: "voice-sample",
        description: step.kind === "element" ? SAMPLE_TEXT : null,
        itemIndex: step.per_item === true ? 0 : null,
        param: step.for_param ?? null,
      };
      const body = codec.body({ ...context, source: () => SAMPLE_URL, binding, voiceId: context.voiceId, description: context.description ?? undefined, param: context.param ?? undefined });
      return { kind: step.kind, endpoint: step.endpoint, context, body };
    });
    const path = resolve(BODIES, binding.upstream, `${model}.json`);
    writeJson(path, {
      model,
      upstream: binding.upstream,
      model_id: binding.model_id,
      runs: runs.map((run) => ({ params: run, prompt, body: buildBody(binding, { params: run, prompt }) })),
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
