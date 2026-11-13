// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Syncs the provider configuration with what each upstream publishes
 * (inner#1775). Run from the repository root with `pnpm provider:prices`,
 * the keys of the upstreams the configuration binds in the environment
 * (each upstream's `key_env` in `config/provider/upstreams.yaml`), read from
 * the repository root's `.env` the way the services read it; a key already in
 * the environment wins.
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
 * WaveSpeed: lists where the live base price differs from the binding's, and
 * where the binding's price for the catalog's default run differs from what
 * WaveSpeed's `/model/price` charges for it (`discounted_price`), without
 * rewriting either.
 * SandBase: each snapshot also records who serves the model (`owned_by` in
 * SandBase's model list).
 * OpenRouter: after the media upstreams, writes `openrouter_prices` in
 * `config/provider/llm.yaml`, OpenRouter's token prices for every model with a
 * direct price there: the cheapest standard-tier endpoint OpenRouter lists for
 * the model (its public endpoints list, no key) at the model's levels
 * (`openRouterLevels`), among its pinned providers when pinned (the endpoints
 * an understand call is held to; a prepared call is not pinned, so it costs
 * that or less), otherwise the one a cheapest LLM call tries first, so such a
 * call ranks OpenRouter beside the direct upstream. Beside them it writes `openrouter_states_quantization`, the
 * models one of whose endpoints states a level, priced or not, and stamps
 * `openrouter_prices_at` with the moment they were read; it names each
 * direct price whose off-peak holidays list no date in the current year (from 1 December, the next).
 *
 * Every problem (a model the upstream no longer has, a changed price fact) is listed at the
 * end and makes the run exit non-zero; whatever could be synced is written
 * first. The WaveSpeed base-price and default-run differences are only printed.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parse, parseDocument, type Document } from "yaml";
import { parseProviderConfig, type ProviderConfigInput } from "../packages/provider/src/config/schema.js";
import { openRouterLevels } from "../packages/provider/src/llm/upstreams/openrouter.js";
import { snapshotOf, type SchemaSnapshot } from "../packages/provider/src/config/upstream-schema.js";
import { buildBody } from "../packages/provider/src/media/body.js";
import { assess } from "../packages/provider/src/pricing/estimate.js";
import { createProvider } from "../packages/provider/src/provider.js";
import { servedDocuments, syncFalBindings } from "./provider-endpoint-docs.mjs";
import { syncedLlmYaml } from "./provider-llm-prices.mjs";
import { priceFactDrift, statedPrice } from "./provider-price-drift.mjs";
import { yamlText } from "./provider-yaml.mjs";

// The test helpers read `__dirname`, which only a CommonJS load of them has.
const { catalog, resolvedParams } = createRequire(import.meta.url)("../packages/provider/src/config/__tests__/shipped.ts") as typeof import("../packages/provider/src/config/__tests__/shipped.js");

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
const ENV = resolve(ROOT, ".env");
if (existsSync(ENV)) process.loadEnvFile(ENV);
const SNAPSHOTS = resolve(ROOT, "packages/provider/test/fixtures/upstream-schemas");
const PRICES = resolve(ROOT, "packages/provider/test/fixtures/upstream-prices");
const MODALITIES = ["image", "video", "audio", "tts", "three_d"] as const;
/** Our catalog's models by name, read once. */
const catalogModels = new Map(catalog().models.map((m) => [m.name, m]));
const MICRO = 1_000_000;

const WAVESPEED = "https://api.wavespeed.ai/api/v3";
const FAL_OPENAPI = "https://fal.ai/api/openapi/queue/openapi.json";
const FAL_PRICING = "https://api.fal.ai/v1/models/pricing";
const SANDBASE_MODELS = "https://api.sandbase.ai/v1/models";
const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";
const LLM = resolve(ROOT, "config/provider/llm.yaml");

/** The prompt of a default run. */
const SAMPLE_PROMPT = "a red fox running through fresh snow at dawn";

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
 * Sync the WaveSpeed bindings: snapshots and the live price differences.
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
  for (const { model, binding } of list) {
    const priced: [string, Pricing | undefined][] = [[binding.model_id, binding.pricing], ...(binding.extra_steps ?? []).map((s): [string, Pricing | undefined] => [s.endpoint, s.pricing])];
    for (const [endpoint, pricing] of priced) {
      const usd = byId.get(endpoint)?.base_price;
      if (usd === undefined || pricing === undefined) continue;
      if (Math.round(usd * MICRO) !== pricing.base_price) differences.push(`${model} ${endpoint}: live base_price ${Math.round(usd * MICRO)}, binding ${pricing.base_price}`);
    }
  }
  process.stdout.write(`${upstream}: ${differences.length} live base prices differ from the binding's\n${differences.map((d) => `  ${d}\n`).join("")}`);

  // The binding's price for the catalog's default run against what WaveSpeed charges for it; listed, never rewritten.
  const media = Object.assign({}, ...[...docs.values()].map((doc) => (doc.toJS() as { models: Record<string, unknown> }).models)) as ProviderConfigInput["media"]["models"];
  const provider = createProvider({ config: { upstreams: upstreams as ProviderConfigInput["upstreams"], media: { models: media } }, keyOf: () => "k", llmMaxRetries: 0, cleanText: (t) => t });
  const charged: string[] = [];
  for (const { model } of list) {
    const binding = provider.config.models[model]?.find((b) => b.upstream === upstream);
    if (binding === undefined) continue;
    const params = resolvedParams(catalogModels.get(model)!, {});
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
  problems.push(...await syncFalBindings(list, {
    json,
    docUrl: (endpoint) => `${FAL_OPENAPI}?endpoint_id=${endpoint}`,
    priceUrl: (endpoint) => `${FAL_PRICING}?endpoint_id=${endpoint}`,
    priceHeaders: { Authorization: `Key ${key}` },
    onDoc: ({ model }, endpoint, doc) => {
      const source = `${FAL_OPENAPI}?endpoint_id=${endpoint}`;
      const input = at(doc, "paths", `/${endpoint}`, "post", "requestBody", "content", "application/json", "schema");
      const output = at(doc, "paths", `/${endpoint}/requests/{request_id}`, "get", "responses", "200", "content", "application/json", "schema");
      if (input === undefined) {
        problems.push(`${model}: fal's OpenAPI for ${endpoint} has no input schema`);
        return;
      }
      writeSnapshot(upstream, endpoint, { ...snapshotOf(input, { root: doc, source }), outputs: snapshotOf(output, { root: doc, source }).fields });
      written += 1;
    },
    onPrice: ({ modality, model, index }, endpoint, path, price) => {
      process.stdout.write(`${model} ${endpoint} on ${upstream}: ${price.unit_price} USD per ${price.unit}\n`);
      // A base price in a new unit would be multiplied by the quantity the formula counts in the old one.
      const source = `${FAL_PRICING}?endpoint_id=${endpoint}`;
      if (!priceFactKept(upstream, endpoint, `${model} ${endpoint} on ${upstream}: unit`, "unit", { source, unit: price.unit })) return;
      docs.get(modality)!.setIn(["models", model, "upstreams", index, ...path, "base_price"], Math.round(price.unit_price * MICRO));
    },
  }));
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
    const endpoints = [binding.model_id, ...(binding.extra_steps ?? []).map((s) => s.endpoint)];
    const read = await servedDocuments(model, endpoints, (endpoint) => json(`${SANDBASE_MODELS}/${endpoint}`, { headers: { Authorization: `Bearer ${key}` } }, { absentOn404: true }), "SandBase no longer lists");
    problems.push(...read.problems);
    for (const [endpoint, answer] of read.served) {
      const source = `${SANDBASE_MODELS}/${endpoint}`;
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
 * standard-tier endpoint's, among its `openrouter_backends` pin's providers when it is pinned, at the model's levels
 * (`openRouterLevels`). It lists in `openrouter_states_quantization` every model one of whose endpoints states a level,
 * priced or not, stamps `openrouter_prices_at` with the moment the prices were read, and prints a notice for each
 * model whose direct price changes later.
 * @throws {ProviderConfigError} When `llm.yaml` is not a valid LLM configuration.
 * @throws {Error} When OpenRouter's endpoints list answers other than 2xx or 404.
 */
async function syncOpenRouterPrices(): Promise<void> {
  const before = readFileSync(LLM, "utf8");
  // Values are read through the schema, as createProvider reads them; the file is written back with its comments.
  const synced = await syncedLlmYaml(
    before,
    (raw) => parseProviderConfig({ upstreams: upstreams as ProviderConfigInput["upstreams"], media: { models: {} }, llm: raw as ProviderConfigInput["llm"] }).llm,
    openRouterLevels,
    // A model OpenRouter does not list answers 404; openRouterPrices names it.
    async (id) => at(await json(`${OPENROUTER_MODELS}/${id}/endpoints`, {}, { absentOn404: true }), "data", "endpoints") as object[] | undefined,
  );
  problems.push(...synced.problems);
  writeFileSync(LLM, synced.text);
  process.stdout.write(`openrouter: ${synced.priced} of ${synced.asked} token prices written\n${synced.notices.map((n) => `  ${n}\n`).join("")}`);
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

const committed = readdirSync(SNAPSHOTS, { recursive: true }).filter((f) => String(f).endsWith(".json")).length;
process.stdout.write(`${committed} schema snapshots in ${SNAPSHOTS}\n`);
if (problems.length > 0) {
  process.stderr.write(`${problems.length} problems:\n${problems.map((p) => `  ${p}\n`).join("")}`);
  process.exitCode = 1;
}
