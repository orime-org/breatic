// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Syncs the provider configuration with what each upstream publishes
 * (inner#1775). Run from the repository root with `pnpm provider:prices`,
 * the keys of the upstreams the configuration binds in the environment
 * (each upstream's `key_env` in `config/provider/upstreams.yaml`).
 *
 * For every bound model and extra-step endpoint of every media upstream it
 * writes the input schema snapshot to
 * `packages/provider/test/fixtures/upstream-schemas/<upstream>/<endpoint>.json`,
 * which `bindings-match-upstream-schema.test.ts` checks the bindings against.
 * Each binding's formula is written by hand from a price fact its upstream
 * states: fal's billing `unit` (the quantity `unit_price` is charged per) and
 * SandBase's `price_formula`. The fact is stored under
 * `packages/provider/test/fixtures/upstream-prices/<upstream>/<endpoint>.json`
 * the first time it is seen; a fact that changed later is a problem and is not
 * overwritten (`priceFactDrift`), so it is reported until the formula is
 * rewritten by hand and the stored fact updated with it.
 * fal: writes each binding's and extra step's `base_price` from fal's
 * `unit_price`, except where the unit changed.
 * WaveSpeed: writes the 3D models' prices (`THREE_D` below) and checks them
 * against WaveSpeed's own price for sample params, writing what WaveSpeed
 * charged for each sample to `packages/provider/test/fixtures/three-d-prices.json`
 * (`three-d-prices.test.ts` prices the samples against it); for every other model it
 * lists where the live base price differs from the binding's, and where the
 * binding's price for the catalog's default run differs from what WaveSpeed's
 * `/model/price` charges for it (`discounted_price`), without rewriting it.
 * SandBase: each snapshot also records who serves the model (`owned_by` in
 * SandBase's model list).
 * OpenRouter: after the media upstreams, writes `openrouter_prices` in
 * `config/provider/llm.yaml`, OpenRouter's token prices for every model with a
 * direct price there: the cheapest endpoint OpenRouter lists for the model
 * (its public endpoints list, no key), the one a cheapest LLM call is served by,
 * so such a call ranks OpenRouter beside the direct upstream. Last it regenerates
 * `config/provider/upstream-field-names.json`: the upstream field names no
 * catalog param shares, which non-provider code must not spell.
 *
 * Every problem (a model the upstream no longer has, a price that does not
 * match) is listed at the end and makes the run exit non-zero; whatever could
 * be synced is written first.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parse, parseDocument, type Document } from "yaml";
import { OPENROUTER_QUANTIZATIONS, type ProviderConfigInput } from "../packages/provider/src/config/schema.js";
import { snapshotOf, type SchemaSnapshot } from "../packages/provider/src/config/upstream-schema.js";
import { buildBody } from "../packages/provider/src/media/body.js";
import { assess } from "../packages/provider/src/pricing/estimate.js";
import { priceUsd } from "../packages/provider/src/pricing/evaluate.js";
import { createProvider } from "../packages/provider/src/provider.js";
import { openRouterPrices } from "./provider-llm-prices.mjs";
import { priceFactDrift, statedPrice } from "./provider-price-drift.mjs";
import { yamlText } from "./provider-yaml.mjs";

// The test helpers read `__dirname`, which only a CommonJS load of them has.
const { catalog } = createRequire(import.meta.url)("../packages/provider/src/config/__tests__/shipped.ts") as typeof import("../packages/provider/src/config/__tests__/shipped.js");

interface Pricing { kind: "formula"; base_price: number; formula: string; discount_rate: number }
interface Binding {
  upstream: string;
  model_id: string;
  params?: Record<string, { field: string; item_fields?: Record<string, { field: string }> }>;
  extra_steps?: { endpoint: string; pricing?: Pricing }[];
  pricing: Pricing;
}
interface Upstream { kind: string; key_env: string }

const ROOT = resolve(import.meta.dirname, "..");
const SNAPSHOTS = resolve(ROOT, "packages/provider/test/fixtures/upstream-schemas");
const PRICES = resolve(ROOT, "packages/provider/test/fixtures/upstream-prices");
const MODALITIES = ["image", "video", "audio", "tts", "three_d"] as const;
const MICRO = 1_000_000;

const WAVESPEED = "https://api.wavespeed.ai/api/v3";
const FAL_OPENAPI = "https://fal.ai/api/openapi/queue/openapi.json";
const FAL_PRICING = "https://api.fal.ai/v1/models/pricing";
const SANDBASE_MODELS = "https://api.sandbase.ai/v1/models";
const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";
const LLM = resolve(ROOT, "config/provider/llm.yaml");
const THREE_D_PRICES = resolve(ROOT, "packages/provider/test/fixtures/three-d-prices.json");

/** A sample input whose clip or file WaveSpeed's price endpoint does not read. */
const SAMPLE_IMAGE = "https://example.com/sample.png";
/** The prompt of a default run. */
const SAMPLE_PROMPT = "a red fox running through fresh snow at dawn";

/**
 * The 3D models' WaveSpeed prices, written by hand from the model pages and checked
 * against `/model/price` for each sample. Hunyuan3D V3 charges Geometry 0.45 USD,
 * Normal (textured) 0.18 more, PBR 0.18 more, and on image-to-3D any extra view
 * 0.18 more; face count does not change the price, and an empty view is no view.
 */
const THREE_D: Readonly<Record<string, { base_price: number; formula: string; samples: Record<string, unknown>[] }>> = (() => {
  const tiers = ["Normal", "Geometry"].flatMap((generate_type) => [false, true].map((enable_pbr) => ({ generate_type, enable_pbr })));
  const textured = '(generate_type = "Geometry" ? 0 : 180000) + (enable_pbr = true ? 180000 : 0)';
  const views = [{}, { back_image: SAMPLE_IMAGE }, { back_image: SAMPLE_IMAGE, left_image: SAMPLE_IMAGE, right_image: SAMPLE_IMAGE }, { back_image: "", left_image: "", right_image: "" }];
  return {
    "wavespeed-ai/hunyuan3d-v3/text-to-3d": {
      base_price: 450_000,
      formula: `{"total_price": base_price + ${textured}}`,
      samples: [{ prompt: "x" }, ...tiers.flatMap((tier) => [40_000, 1_500_000].map((face_count) => ({ prompt: "x", ...tier, face_count })))],
    },
    "wavespeed-ai/hunyuan3d-v3/image-to-3d": {
      base_price: 450_000,
      formula: `{"total_price": base_price + ${textured} + ((back_image or left_image or right_image) ? 180000 : 0)}`,
      samples: [{ image: SAMPLE_IMAGE }, ...tiers.flatMap((tier) => views.map((view) => ({ image: SAMPLE_IMAGE, ...tier, ...view })))],
    },
    "wavespeed-ai/hunyuan-3d-v3.1/image-to-3d-rapid": { base_price: 270_000, formula: "", samples: [{ image: SAMPLE_IMAGE }] },
    // Meshy 6 charges 1.44 USD whatever the fields the binding sends; only mode, texture_resolution and rigging, which it never sends, change it.
    "meshy/v6/text-to-3d": {
      base_price: 1_440_000,
      formula: "",
      samples: [{ prompt: "x" }, { prompt: "" }, { prompt: "x", topology: "quad", target_polycount: 300_000, enable_pbr: true, symmetry_mode: "off", pose_mode: "t-pose" }],
    },
  };
})();

const problems: string[] = [];

/**
 * Read a yaml file under the repository root.
 * @param path - The path.
 * @returns Its content.
 */
function yaml<T>(path: string): T {
  return parse(readFileSync(resolve(ROOT, path), "utf8")) as T;
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

/** How often a rate-limited request is asked again before the run gives up. */
const RATE_LIMIT_RETRIES = 6;

/**
 * One upstream answer as JSON; a 429 is asked again after the upstream's Retry-After, or a doubling wait.
 * @param url - The address.
 * @param init - The request.
 * @param options - How to read the answer.
 * @param options.absentOn404 - Whether a 404 means "not listed" and gives undefined rather than an error.
 * @returns The answer; undefined on a 404 when `absentOn404` is set.
 * @throws {Error} When the upstream does not answer 2xx (or 404 with `absentOn404`).
 */
async function json(url: string, init: RequestInit = {}, { absentOn404 = false }: { absentOn404?: boolean } = {}): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      await sleep((Number(res.headers.get("retry-after")) || 2 ** attempt * 2) * 1000);
      continue;
    }
    if (res.status === 404 && absentOn404) return undefined;
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url} answered ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as unknown;
  }
}

/**
 * Walk a path into a JSON value.
 * @param value - The value.
 * @param keys - The keys.
 * @returns What is there, or undefined.
 */
function at(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>((v, key) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined), value);
}

/**
 * Write one endpoint's snapshot.
 * @param upstream - The upstream's name.
 * @param endpoint - The model id or step endpoint.
 * @param snapshot - The snapshot.
 */
function writeSnapshot(upstream: string, endpoint: string, snapshot: SchemaSnapshot): void {
  writeJson(resolve(SNAPSHOTS, upstream, `${endpoint}.json`), snapshot);
}

const upstreams = yaml<{ upstreams: Record<string, Upstream> }>("config/provider/upstreams.yaml").upstreams;
const docs = new Map<string, Document>(MODALITIES.map((m) => [m, parseDocument(readFileSync(resolve(ROOT, `config/provider/media/${m}.yaml`), "utf8"))]));

/** Every binding with where it sits in its file. */
const bindings = [...docs].flatMap(([modality, doc]) =>
  Object.entries((doc.toJS() as { models: Record<string, { upstreams: Binding[] }> }).models).flatMap(([model, { upstreams: list }]) =>
    list.map((binding, index) => ({ modality, model, index, binding }))));

/**
 * The key of an upstream, or undefined after recording that it is missing.
 * @param upstream - The upstream's name.
 * @returns The key.
 */
function keyOf(upstream: string): string | undefined {
  const name = upstreams[upstream]?.key_env;
  const key = name === undefined ? undefined : process.env[name];
  if (key === undefined || key === "") problems.push(`${upstream}: ${name ?? "no key_env"} is not set; its models were not synced`);
  return key === "" ? undefined : key;
}

/**
 * Sync the WaveSpeed bindings: snapshots, the 3D prices and their check, and the live price differences.
 * @param upstream - The upstream's name.
 * @param list - Its bindings.
 */
async function syncWaveSpeed(upstream: string, list: typeof bindings): Promise<void> {
  const key = keyOf(upstream);
  if (key === undefined) return;
  const headers = { Authorization: `Bearer ${key}`, "content-type": "application/json" };
  const models = at(await json(`${WAVESPEED}/models`, { headers }), "data") as { model_id: string; base_price: number; api_schema?: { api_schemas?: { type: string; request_schema?: unknown }[] } }[];
  const byId = new Map(models.map((m) => [m.model_id, m]));
  let written = 0;
  for (const { model, binding } of list) {
    for (const endpoint of [binding.model_id, ...(binding.extra_steps ?? []).map((s) => s.endpoint)]) {
      const schema = byId.get(endpoint)?.api_schema?.api_schemas?.find((s) => s.type === "model_run")?.request_schema;
      if (schema === undefined) {
        problems.push(`${model}: WaveSpeed lists no model ${endpoint}`);
        continue;
      }
      writeSnapshot(upstream, endpoint, snapshotOf(schema, { root: schema, source: `${WAVESPEED}/models` }));
      written += 1;
    }
  }
  process.stdout.write(`${upstream}: ${written} schema snapshots written\n`);

  const differences: string[] = [];
  const threeDCharged = new Map<string, { inputs: Record<string, unknown>; usd: number }[]>();
  for (const { modality, model, index, binding } of list) {
    const live = byId.get(binding.model_id);
    const threeD = THREE_D[binding.model_id];
    if (threeD !== undefined) {
      docs.get(modality)!.setIn(["models", model, "upstreams", index, "pricing"], { kind: "formula", base_price: threeD.base_price, formula: threeD.formula, discount_rate: 100 });
      for (const inputs of threeD.samples) {
        const answer = await json(`${WAVESPEED}/model/price`, { method: "POST", headers, body: JSON.stringify({ model_id: binding.model_id, inputs }) });
        const usd = statedPrice(answer);
        const local = await priceUsd({ basePrice: threeD.base_price, formula: threeD.formula, discountRate: 100 }, inputs, {});
        const line = `${model} ${JSON.stringify(inputs)}: WaveSpeed ${usd}, local ${local}`;
        process.stdout.write(`${line}\n`);
        if (typeof usd !== "number" || Math.abs(usd - local) > 1e-9) problems.push(`price mismatch: ${line}`);
        if (typeof usd === "number") threeDCharged.set(binding.model_id, [...(threeDCharged.get(binding.model_id) ?? []), { inputs, usd }]);
      }
      continue;
    }
    if (modality === "three_d") {
      if (live === undefined) problems.push(`${model}: no real 3D price could be written; WaveSpeed lists no ${binding.model_id}`);
      else problems.push(`${model}: no hand-written 3D price for ${binding.model_id} in THREE_D`);
    }
    const priced: [string, Pricing | undefined][] = [[binding.model_id, binding.pricing], ...(binding.extra_steps ?? []).map((s): [string, Pricing | undefined] => [s.endpoint, s.pricing])];
    for (const [endpoint, pricing] of priced) {
      const usd = byId.get(endpoint)?.base_price;
      if (usd === undefined || pricing === undefined) continue;
      if (Math.round(usd * MICRO) !== pricing.base_price) differences.push(`${model} ${endpoint}: live base_price ${Math.round(usd * MICRO)}, binding ${pricing.base_price}`);
    }
  }
  // Written whole each run, in THREE_D order, so a sample dropped from THREE_D leaves the fixture with it.
  writeJson(THREE_D_PRICES, Object.fromEntries(Object.keys(THREE_D).flatMap((id) => (threeDCharged.has(id) ? [[id, threeDCharged.get(id)]] : []))));
  process.stdout.write(`${upstream}: ${differences.length} live base prices differ from the binding's\n${differences.map((d) => `  ${d}\n`).join("")}`);

  // The binding's price for the catalog's default run against what WaveSpeed charges for it; listed, never rewritten.
  const media = Object.assign({}, ...[...docs.values()].map((doc) => (doc.toJS() as { models: Record<string, unknown> }).models)) as ProviderConfigInput["media"]["models"];
  const provider = createProvider({ config: { upstreams: upstreams as ProviderConfigInput["upstreams"], media: { models: media } }, keyOf: () => "k", llmMaxRetries: 0, cleanText: (t) => t });
  const defaults = new Map(catalog().models.map((m) => [m.name, m.params as Record<string, { default?: unknown }>]));
  const charged: string[] = [];
  for (const { modality, model } of list) {
    if (modality === "three_d") continue;
    const binding = provider.config.models[model]?.find((b) => b.upstream === upstream);
    if (binding === undefined) continue;
    const params = Object.fromEntries(Object.entries(defaults.get(model) ?? {}).map(([name, p]) => [name, p.default]).filter(([, v]) => v !== undefined && v !== null));
    const prompt = binding.prompt_field === undefined ? "" : SAMPLE_PROMPT;
    const inputs = buildBody(binding, { params, prompt });
    const read = await assess(provider.pricingRules(model), upstream, { params, prompt, durations: {}, placeholders: [], durationsMissing: [] });
    const local = read === undefined ? "no rule" : "rejected" in read ? `refused (${JSON.stringify(read.rejected)})` : read.estimate.usd;
    let live: number | string;
    try {
      const answer = await json(`${WAVESPEED}/model/price`, { method: "POST", headers, body: JSON.stringify({ model_id: binding.model_id, inputs }) });
      live = statedPrice(answer);
    } catch (error) {
      live = `not priced (${(error as Error).message.slice(0, 120)})`;
    }
    if (typeof local !== "number" || typeof live !== "number" || Math.abs(local - live) > 1e-9) charged.push(`${model} ${JSON.stringify(inputs)}: WaveSpeed ${live}, binding ${local}`);
  }
  process.stdout.write(`${upstream}: ${charged.length} default runs priced differently from what WaveSpeed charges\n${charged.map((d) => `  ${d}\n`).join("")}`);
}

/**
 * Compare an endpoint's stored price fact with the one its upstream states now: store it the first
 * time, record a problem when it changed.
 * @param upstream - The upstream's name.
 * @param endpoint - The model id or step endpoint.
 * @param label - The model, endpoint, upstream and fact, for the problem.
 * @param fact - The fact's key in the stored file.
 * @param stored - The file's content when the fact is first stored: its source and the fact.
 * @returns True when the fact is unchanged or new, false when it changed.
 */
function priceFactKept(upstream: string, endpoint: string, label: string, fact: string, stored: Record<string, unknown>): boolean {
  const file = resolve(PRICES, upstream, `${endpoint}.json`);
  const before = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)[fact] : undefined;
  const drift = priceFactDrift(before, stored[fact], label);
  if (drift.store) writeJson(file, stored);
  if (drift.problem !== undefined) problems.push(drift.problem);
  return drift.problem === undefined;
}

/**
 * Sync the fal bindings: input and output snapshots, each priced endpoint's billing unit (stored, and a
 * change reported), and each binding's and extra step's base price from its unit price where the unit is unchanged.
 * @param upstream - The upstream's name.
 * @param list - Its bindings.
 */
async function syncFal(upstream: string, list: typeof bindings): Promise<void> {
  const key = keyOf(upstream);
  if (key === undefined) return;
  let written = 0;
  for (const { modality, model, index, binding } of list) {
    for (const endpoint of [binding.model_id, ...(binding.extra_steps ?? []).map((s) => s.endpoint)]) {
      const source = `${FAL_OPENAPI}?endpoint_id=${endpoint}`;
      const doc = await json(source);
      const input = at(doc, "paths", `/${endpoint}`, "post", "requestBody", "content", "application/json", "schema");
      const output = at(doc, "paths", `/${endpoint}/requests/{request_id}`, "get", "responses", "200", "content", "application/json", "schema");
      if (input === undefined) {
        problems.push(`${model}: fal's OpenAPI for ${endpoint} has no input schema`);
        continue;
      }
      writeSnapshot(upstream, endpoint, { ...snapshotOf(input, { root: doc, source }), outputs: snapshotOf(output, { root: doc, source }).fields });
      written += 1;
    }
    const priced: [string, (string | number)[]][] = [
      [binding.model_id, ["pricing"]],
      ...(binding.extra_steps ?? []).flatMap((s, i): [string, (string | number)[]][] => (s.pricing === undefined ? [] : [[s.endpoint, ["extra_steps", i, "pricing"]]])),
    ];
    for (const [endpoint, path] of priced) {
      const price = (at(await json(`${FAL_PRICING}?endpoint_id=${endpoint}`, { headers: { Authorization: `Key ${key}` } }), "prices") as { endpoint_id: string; unit_price: number; unit: string }[])
        .find((p) => p.endpoint_id === endpoint);
      if (price === undefined) {
        problems.push(`${model}: fal has no price for ${endpoint}`);
        continue;
      }
      process.stdout.write(`${model} ${endpoint} on ${upstream}: ${price.unit_price} USD per ${price.unit}\n`);
      // A base price in a new unit would be multiplied by the quantity the formula counts in the old one.
      const source = `${FAL_PRICING}?endpoint_id=${endpoint}`;
      if (!priceFactKept(upstream, endpoint, `${model} ${endpoint} on ${upstream}: unit`, "unit", { source, unit: price.unit })) continue;
      docs.get(modality)!.setIn(["models", model, "upstreams", index, ...path, "base_price"], Math.round(price.unit_price * MICRO));
    }
  }
  process.stdout.write(`${upstream}: ${written} schema snapshots written\n`);
}

/**
 * Sync the SandBase bindings: snapshots with execution modes and owner of the model and its extra steps, and the stored price formulas.
 * @param upstream - The upstream's name.
 * @param list - Its bindings.
 */
async function syncSandBase(upstream: string, list: typeof bindings): Promise<void> {
  const key = keyOf(upstream);
  if (key === undefined) return;
  // The bare list holds only the language models; each media type is listed under its own `type`.
  const owners = new Map<string, string | undefined>();
  for (const type of ["", "?type=image", "?type=video", "?type=audio"]) {
    for (const m of at(await json(`${SANDBASE_MODELS}${type}`, { headers: { Authorization: `Bearer ${key}` } }), "data") as { id: string; owned_by?: string }[]) owners.set(m.id, m.owned_by);
  }
  let written = 0;
  for (const { model, binding } of list) {
    for (const endpoint of [binding.model_id, ...(binding.extra_steps ?? []).map((s) => s.endpoint)]) {
      const source = `${SANDBASE_MODELS}/${endpoint}`;
      const answer = await json(source, { headers: { Authorization: `Bearer ${key}` } });
      const doc = at(answer, "unified_schema");
      const input = at(doc, "paths", "/v1/run", "post", "requestBody", "content", "application/json", "schema");
      if (input === undefined) {
        problems.push(`${model}: SandBase's schema for ${endpoint} has no input schema`);
        continue;
      }
      const modes = [at(answer, "execution_mode"), ...((at(answer, "supported_modes") as unknown[] | null) ?? [])].filter((m): m is string => typeof m === "string");
      const owner = owners.get(endpoint);
      writeSnapshot(upstream, endpoint, { ...snapshotOf(input, { root: doc, source }), modes: [...new Set(modes)], ...(owner === undefined ? {} : { owned_by: owner }) });
      written += 1;
      const formula = at(answer, "model_card", "price_formula") ?? null;
      priceFactKept(upstream, endpoint, `${model} ${endpoint} on ${upstream}: price_formula`, "price_formula", { source, price_formula: formula });
    }
  }
  process.stdout.write(`${upstream}: ${written} schema snapshots written\n`);
}

/**
 * Write OpenRouter's token prices into `openrouter_prices` of `config/provider/llm.yaml`, for every model
 * of its `prices` and in their order, keeping the file's comments; a model given no price is a problem.
 * OpenRouter's id for a model is `vendor_ids[model].openrouter` when set, else ours; its price is its cheapest
 * standard-tier endpoint's, among its `openrouter_backends` pin's providers when it is pinned.
 * @throws {Error} When OpenRouter's endpoints list answers other than 2xx or 404.
 */
async function syncOpenRouterPrices(): Promise<void> {
  const doc = parseDocument(readFileSync(LLM, "utf8"));
  const llm = doc.toJS() as {
    prices?: Record<string, unknown>;
    vendor_ids?: Record<string, Record<string, string>>;
    openrouter_quantizations?: string[];
    openrouter_backends?: Record<string, { only?: string[] }>;
  };
  const ids = new Map(Object.keys(llm.prices ?? {}).map((model) => [model, llm.vendor_ids?.[model]?.openrouter ?? model]));
  const pins = new Map(Object.entries(llm.openrouter_backends ?? {}).flatMap(([model, { only }]) => (only === undefined ? [] : [[model, only] as const])));
  type Endpoint = { tag?: unknown; service_tier?: unknown; quantization?: unknown; pricing?: { prompt?: unknown; completion?: unknown } };
  const endpoints = new Map<string, Endpoint[]>();
  for (const id of new Set(ids.values())) {
    // A model OpenRouter does not list answers 404; openRouterPrices names it.
    const answer = await json(`${OPENROUTER_MODELS}/${id}/endpoints`, {}, { absentOn404: true });
    if (answer !== undefined) endpoints.set(id, at(answer, "data", "endpoints") as Endpoint[]);
  }
  const { prices, problems: unpriced } = openRouterPrices(endpoints, ids, llm.openrouter_quantizations ?? OPENROUTER_QUANTIZATIONS, pins);
  problems.push(...unpriced);
  doc.set("openrouter_prices", doc.createNode(prices));
  const text = yamlText(doc, { lineWidth: 0 });
  if (text !== readFileSync(LLM, "utf8")) writeFileSync(LLM, text);
  process.stdout.write(`openrouter: ${Object.keys(prices).length} of ${ids.size} token prices written\n`);
}

const SYNC: Readonly<Record<string, (upstream: string, list: typeof bindings) => Promise<void>>> = { wavespeed: syncWaveSpeed, fal: syncFal, sandbase: syncSandBase };

for (const upstream of [...new Set(bindings.map((b) => b.binding.upstream))]) {
  const kind = upstreams[upstream]?.kind ?? "";
  const sync = SYNC[kind];
  if (sync === undefined) {
    problems.push(`${upstream}: no schema or price source for upstreams of kind "${kind}"`);
    continue;
  }
  await sync(upstream, bindings.filter((b) => b.binding.upstream === upstream));
}

for (const [modality, doc] of docs) {
  const path = resolve(ROOT, `config/provider/media/${modality}.yaml`);
  const text = yamlText(doc, { lineWidth: 0 });
  if (text !== readFileSync(path, "utf8")) writeFileSync(path, text);
}

await syncOpenRouterPrices();

const ours = new Set(catalog().models
  .flatMap((m) => Object.entries(m.params).flatMap(([name, p]) => [name, ...Object.keys(p.fields ?? {})])));
const fieldNames = new Set(bindings.flatMap(({ binding }) => Object.values(binding.params ?? {})
  .flatMap((p) => [p.field, ...Object.values(p.item_fields ?? {}).map((f) => f.field)])
  .flatMap((field) => field.split("."))));
writeJson(resolve(ROOT, "config/provider/upstream-field-names.json"), [...fieldNames].filter((name) => !ours.has(name)).sort());

const committed = readdirSync(SNAPSHOTS, { recursive: true }).filter((f) => String(f).endsWith(".json")).length;
process.stdout.write(`${committed} schema snapshots in ${SNAPSHOTS}\n`);
if (problems.length > 0) {
  process.stderr.write(`${problems.length} problems:\n${problems.map((p) => `  ${p}\n`).join("")}`);
  process.exitCode = 1;
}
