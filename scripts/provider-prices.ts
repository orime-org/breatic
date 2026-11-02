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
 * fal: writes each binding's `base_price` from fal's `unit_price`. SandBase:
 * stores each model's `price_formula` under
 * `packages/provider/test/fixtures/upstream-prices/sandbase/` and lists the
 * bindings whose formula changed, to be rewritten in JSONata by hand.
 * WaveSpeed: writes the 3D models' prices (`THREE_D` below) and checks them
 * against WaveSpeed's own price for sample params; for every other model it
 * lists where the live price differs from the binding's. Last it regenerates
 * `config/provider/upstream-field-names.json`: the upstream field names no
 * catalog param shares, which non-provider code must not spell.
 *
 * Every problem (a model the upstream no longer has, a price that does not
 * match) is listed at the end and makes the run exit non-zero; whatever could
 * be synced is written first.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parse, parseDocument, type Document } from "yaml";
import { snapshotOf, type SchemaSnapshot } from "../packages/provider/src/config/upstream-schema.js";
import { priceUsd } from "../packages/provider/src/pricing/evaluate.js";

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
const CATALOG = ["image/models.yaml", "video/models.yaml", "audio/models.yaml", "tts/models.yaml", "three_d/meshy.yaml", "three_d/hunyuan3d.yaml"];
const MICRO = 1_000_000;

const WAVESPEED = "https://api.wavespeed.ai/api/v3";
const FAL_OPENAPI = "https://fal.ai/api/openapi/queue/openapi.json";
const FAL_PRICING = "https://api.fal.ai/v1/models/pricing";
const SANDBASE_MODELS = "https://api.sandbase.ai/v1/models";

/** A sample input whose clip or file WaveSpeed's price endpoint does not read. */
const SAMPLE_IMAGE = "https://example.com/sample.png";

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
 * @returns The answer.
 * @throws {Error} When the upstream does not answer 2xx.
 */
async function json(url: string, init: RequestInit = {}): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      await sleep((Number(res.headers.get("retry-after")) || 2 ** attempt * 2) * 1000);
      continue;
    }
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
  for (const { modality, model, index, binding } of list) {
    const live = byId.get(binding.model_id);
    const threeD = THREE_D[binding.model_id];
    if (threeD !== undefined) {
      docs.get(modality)!.setIn(["models", model, "upstreams", index, "pricing"], { kind: "formula", base_price: threeD.base_price, formula: threeD.formula, discount_rate: 100 });
      for (const inputs of threeD.samples) {
        const answer = await json(`${WAVESPEED}/model/price`, { method: "POST", headers, body: JSON.stringify({ model_id: binding.model_id, inputs }) });
        const usd = Number(at(answer, "data", "price"));
        const local = await priceUsd({ basePrice: threeD.base_price, formula: threeD.formula, discountRate: 100 }, inputs, {});
        const line = `${model} ${JSON.stringify(inputs)}: WaveSpeed ${usd}, local ${local}`;
        process.stdout.write(`${line}\n`);
        if (Math.abs(usd - local) > 1e-9) problems.push(`price mismatch: ${line}`);
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
  process.stdout.write(`${upstream}: ${differences.length} live base prices differ from the binding's\n${differences.map((d) => `  ${d}\n`).join("")}`);
}

/**
 * Sync the fal bindings: input and output snapshots, and each binding's base price from its unit price.
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
    const price = (at(await json(`${FAL_PRICING}?endpoint_id=${binding.model_id}`, { headers: { Authorization: `Key ${key}` } }), "prices") as { endpoint_id: string; unit_price: number; unit: string }[])
      .find((p) => p.endpoint_id === binding.model_id);
    if (price === undefined) {
      problems.push(`${model}: fal has no price for ${binding.model_id}`);
      continue;
    }
    docs.get(modality)!.setIn(["models", model, "upstreams", index, "pricing", "base_price"], Math.round(price.unit_price * MICRO));
    process.stdout.write(`${model} on ${upstream}: ${price.unit_price} USD per ${price.unit}\n`);
  }
  process.stdout.write(`${upstream}: ${written} schema snapshots written\n`);
}

/**
 * Sync the SandBase bindings: snapshots with execution modes, and the stored price formulas.
 * @param upstream - The upstream's name.
 * @param list - Its bindings.
 */
async function syncSandBase(upstream: string, list: typeof bindings): Promise<void> {
  const key = keyOf(upstream);
  if (key === undefined) return;
  let written = 0;
  for (const { model, binding } of list) {
    const source = `${SANDBASE_MODELS}/${binding.model_id}`;
    const answer = await json(source, { headers: { Authorization: `Bearer ${key}` } });
    const doc = at(answer, "unified_schema");
    const input = at(doc, "paths", "/v1/run", "post", "requestBody", "content", "application/json", "schema");
    if (input === undefined) {
      problems.push(`${model}: SandBase's schema for ${binding.model_id} has no input schema`);
      continue;
    }
    const modes = [at(answer, "execution_mode"), ...((at(answer, "supported_modes") as unknown[] | null) ?? [])].filter((m): m is string => typeof m === "string");
    writeSnapshot(upstream, binding.model_id, { ...snapshotOf(input, { root: doc, source }), modes: [...new Set(modes)] });
    written += 1;
    const formula = at(answer, "model_card", "price_formula") ?? null;
    const file = resolve(PRICES, upstream, `${binding.model_id}.json`);
    const before = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { price_formula: unknown }).price_formula : undefined;
    if (before !== undefined && before !== formula) process.stdout.write(`${model} on ${upstream}: price_formula changed, rewrite its pricing: ${JSON.stringify(before)} -> ${JSON.stringify(formula)}\n`);
    writeJson(file, { source, price_formula: formula });
  }
  process.stdout.write(`${upstream}: ${written} schema snapshots written\n`);
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
  const text = doc.toString({ lineWidth: 0 });
  if (text !== readFileSync(path, "utf8")) writeFileSync(path, text);
}

const ours = new Set(CATALOG.flatMap((file) => yaml<{ models: { params?: Record<string, { fields?: Record<string, unknown> }> }[] }>(`config/models/${file}`).models)
  .flatMap((m) => Object.entries(m.params ?? {}).flatMap(([name, p]) => [name, ...Object.keys(p.fields ?? {})])));
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
