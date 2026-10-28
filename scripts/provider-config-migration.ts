// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Writes the provider package's configuration from today's catalog
 * (inner#1743, design 4.5), so the provider tests can prove the move changes
 * nothing: every catalog and 3D model bound to WaveSpeed at weight 1 with the
 * upstream fields, value spellings, extra steps and pricing the catalog
 * declares today, the upstreams from `config/models/<modality>/providers.yaml`
 * and the LLM routes from `packages/domain/src/agent/llm.ts`.
 *
 * Run from the repository root with `pnpm exec tsx scripts/provider-config-migration.ts`.
 * It writes `config/provider/upstreams.yaml`, `config/provider/media/<modality>.yaml`,
 * `config/provider/llm.yaml` and `config/provider/routing.yaml.template`.
 * It is a one-off: run it again when the catalog changes before the
 * application moves to the provider package, and delete it with the old
 * implementation.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse, stringify } from "yaml";

interface RawPricing { base_price: number; formula: string; discount_rate: number }
interface RawParam {
  upstream?: string;
  upstream_values?: Record<string, string | number | boolean>;
  item_key?: string;
  absent_value?: string | number | boolean;
  mention?: string;
  joins?: string;
}
interface RawStep { endpoint: string; at: "before" | "after"; for_param?: string; per_item?: boolean; reused?: boolean; pricing: RawPricing }
interface RawModel {
  name: string;
  takes_prompt?: boolean;
  prompt_upstream?: string;
  cost_per_call?: number;
  params?: Record<string, RawParam>;
  providers?: { name: string; model_id: string; pricing?: RawPricing }[];
  extra_steps?: RawStep[];
  reused_by?: string;
}

const ROOT = resolve(import.meta.dirname, "..");

/**
 * Params the application layer turns into the prompt itself (design 7.1): no
 * upstream field carries them. Copied from the families in
 * `packages/worker/src/providers/families/`.
 */
const APP_PARAMS: Readonly<Record<string, readonly string[]>> = {
  "nano-banana-2": ["enable_camera", "camera", "lens", "focal_length", "aperture"],
  "nano-banana-2-relight": [
    "light_azimuth",
    "light_elevation",
    "light_color",
    "light_color_hex",
    "light_intensity",
    "light_quality",
    "light_reference",
  ],
};

/** Params whose value the upstream takes in its own shape (design 4.2). */
const TRANSFORMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "minimax-speech-2.8-hd": { pronunciation_dict: "pronunciation_pairs" },
};

/**
 * Read a yaml file under the repository root.
 * @param path - The path.
 * @returns Its content.
 */
function yaml<T>(path: string): T {
  return parse(readFileSync(resolve(ROOT, path), "utf8")) as T;
}

/**
 * Write a yaml file under `config/provider/`, with a header.
 * @param path - The path below `config/provider/`.
 * @param header - The comment lines on top.
 * @param content - The content.
 */
function write(path: string, header: string, content: unknown): void {
  const out = resolve(ROOT, "config/provider", path);
  mkdirSync(dirname(out), { recursive: true });
  const body = content === null ? "" : stringify(content, { lineWidth: 0 });
  writeFileSync(out, `${header.trim().split("\n").map((line) => `# ${line}`.trimEnd()).join("\n")}\n\n${body}`);
}

/**
 * A pricing contract in the binding's shape.
 * @param raw - The catalog's contract.
 * @returns The rule.
 */
function pricingOf(raw: RawPricing): Record<string, unknown> {
  return { kind: "formula", base_price: raw.base_price, formula: raw.formula, discount_rate: raw.discount_rate };
}

/**
 * The kind of an extra step, read the way `packages/worker/src/providers/plan-steps.ts` reads it.
 * @param step - The step.
 * @returns Its kind.
 * @throws {Error} When no step kind runs its endpoint.
 */
function kindOf(step: RawStep): string {
  if (step.at === "after") return "speak";
  if (step.endpoint === "mureka-ai/create-upload-id" && step.for_param === "song") return "upload_reference";
  if (step.endpoint === "mureka-ai/create-upload-id" && step.for_param === "melody") return "upload_melody";
  if (step.endpoint === "mureka-ai/vocal-clone") return "vocal";
  if (step.endpoint === "kwaivgi/kling-elements") return "element";
  throw new Error(`No step runs ${step.endpoint}`);
}

/**
 * A capture from a source file, required.
 * @param path - The file below the repository root.
 * @param pattern - The pattern; its first group is the answer.
 * @returns The capture.
 * @throws {Error} When the file no longer says it.
 */
function capture(path: string, pattern: RegExp): string {
  const found = pattern.exec(readFileSync(resolve(ROOT, path), "utf8"))?.[1];
  if (found === undefined) throw new Error(`${path} no longer matches ${pattern}`);
  return found;
}

const understand = yaml<{ max_output_tokens: number }>("config/understand.yaml");
const describe = {
  model: capture("packages/shared/src/understand/pinned-model.ts", /id: "([^"]+)"/),
  question: capture("packages/worker/src/handlers/step-deps.ts", /const DESCRIBE_QUESTION =\s*"([^"]+)"/),
  max_output_tokens: understand.max_output_tokens,
};

/**
 * One model's WaveSpeed binding.
 * @param model - The catalog entry.
 * @param threeD - Whether it is a 3D model, whose family passes every param through.
 * @returns The binding.
 * @throws {Error} When the model has no WaveSpeed provider or no price.
 */
function bindingOf(model: RawModel, threeD: boolean): Record<string, unknown> {
  const provider = model.providers?.find((p) => p.name === "wavespeed");
  if (provider === undefined) throw new Error(`${model.name} has no WaveSpeed provider`);
  const skipped = new Set(APP_PARAMS[model.name] ?? []);
  const params: Record<string, Record<string, unknown>> = {};
  const mentions: Record<string, string> = {};
  for (const [name, spec] of Object.entries(model.params ?? {})) {
    if (spec.mention !== undefined) mentions[name] = spec.mention;
    // A slot that joins a pool travels inside it; no field carries the slot itself.
    if (skipped.has(name) || spec.joins !== undefined) continue;
    const transform = TRANSFORMS[model.name]?.[name];
    params[name] = {
      field: threeD ? name : (spec.upstream ?? name),
      ...(spec.upstream_values === undefined ? {} : { values: spec.upstream_values }),
      ...(spec.item_key === undefined ? {} : { item_key: spec.item_key }),
      ...(spec.absent_value === undefined ? {} : { absent_value: spec.absent_value }),
      ...(transform === undefined ? {} : { transform }),
    };
  }
  const steps = (model.extra_steps ?? []).map((step) => {
    const kind = kindOf(step);
    return {
      kind,
      endpoint: step.endpoint,
      at: step.at,
      ...(step.for_param === undefined ? {} : { for_param: step.for_param }),
      ...(step.per_item === undefined ? {} : { per_item: step.per_item }),
      ...(step.reused === undefined ? {} : { reused: step.reused }),
      ...(kind === "element" ? { describe } : {}),
      pricing: pricingOf(step.pricing),
    };
  });
  // 3D models carry no WaveSpeed contract today; their per-call credit figure
  // (cents) stands in as a flat price until the price sync writes the real one.
  const pricing = provider.pricing ?? (model.cost_per_call === undefined ? undefined : {
    base_price: model.cost_per_call * 10_000,
    formula: "",
    discount_rate: 100,
  });
  if (pricing === undefined) throw new Error(`${model.name} has no price`);
  return {
    upstream: "wavespeed",
    weight: 1,
    model_id: provider.model_id,
    // Today's 3D path sends the prompt on every call, "" when there is none.
    ...(threeD ? { prompt_field: "prompt", send_empty_prompt: true } : model.takes_prompt === true ? { prompt_field: model.prompt_upstream ?? "prompt" } : {}),
    ...(Object.keys(params).length === 0 ? {} : { params }),
    ...(steps.length === 0 ? {} : { extra_steps: steps }),
    ...(model.reused_by === undefined ? {} : { reused_by: model.reused_by }),
    ...(Object.keys(mentions).length === 0 ? {} : { mentions }),
    pricing: pricingOf(pricing),
  };
}

const MEDIA_HEADER = `
Where each of our {modality} models runs, upstream by upstream (design 4.2).
Weight is priority: the lowest configured weight is tried first, and weights
are unique per model. Each binding names the upstream's model id, the field
the prompt goes in (\`send_empty_prompt\` sends it even when it is empty),
and how each of our params is written there: \`field\`,
\`values\` (our value to the upstream's spelling), \`item_key\` (each list
entry wrapped under it), \`absent_value\` (holding it sends nothing) and
\`transform\`. A param not listed is not sent to that upstream. \`mentions\` is
how the prompt names a param's sources there ({n} counts from 1, {i} from 0).
\`pricing\` is the upstream's contract: base_price in millionths of a USD, a
JSONata formula (empty means base_price per call), discount_rate in percent.
`;

const sources: [string, string[]][] = [
  ["image", ["config/models/image/models.yaml"]],
  ["video", ["config/models/video/models.yaml"]],
  ["audio", ["config/models/audio/models.yaml"]],
  ["tts", ["config/models/tts/models.yaml"]],
  ["three_d", ["config/models/three_d/meshy.yaml", "config/models/three_d/hunyuan3d.yaml"]],
];
for (const [modality, files] of sources) {
  const models: Record<string, { upstreams: Record<string, unknown>[] }> = {};
  for (const file of files) {
    for (const model of yaml<{ models: RawModel[] }>(file).models) {
      models[model.name] = { upstreams: [bindingOf(model, modality === "three_d")] };
    }
  }
  write(`media/${modality}.yaml`, MEDIA_HEADER.replace("{modality}", modality.replace("_", " ")), { models });
}

const concurrency = new Set(
  ["image", "video", "audio", "tts", "three_d"].map((m) => yaml<{ wavespeed: { max_concurrency: number } }>(`config/models/${m}/providers.yaml`).wavespeed.max_concurrency),
);
if (concurrency.size !== 1) throw new Error("The modalities disagree on WaveSpeed's concurrency");

const llmSource = "packages/domain/src/agent/llm.ts";
const direct = [...readFileSync(resolve(ROOT, llmSource), "utf8").matchAll(/prefix: "([^"]+)",\s*keyName: "([^"]+)",\s*name: "([^"]+)"/g)]
  .map(([, prefix, keyName, name]) => ({ prefix: prefix!, keyName: keyName!, name: name! }));
if (direct.length === 0) throw new Error(`${llmSource} no longer lists its direct routes`);

/** Where each vendor's AI SDK provider answers by default; provider reaches them the same way. */
const SDK_BASE_URLS: Readonly<Record<string, string>> = {
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
};

const wavespeed = yaml<{ wavespeed: { base_url: string; api_key_env: string } }>("config/models/image/providers.yaml").wavespeed;
write("upstreams.yaml", `
Every upstream provider reaches (design 4.1): the adapter kind that speaks to
it, its address, the environment variable that holds its key, and for media
upstreams how many requests one process sends it at once. An upstream whose
key variable is empty is skipped, and the call says which variable is missing.
`, {
  upstreams: {
    wavespeed: { kind: "wavespeed", base_url: wavespeed.base_url, key_env: wavespeed.api_key_env, concurrency: [...concurrency][0] },
    openrouter: { kind: "openrouter", base_url: "https://openrouter.ai/api/v1", key_env: capture(llmSource, /FALLBACK_ROUTE: Route = \{\s*keyName: "([^"]+)"/) },
    ...Object.fromEntries(direct.map((d) => {
      const base = SDK_BASE_URLS[d.name];
      if (base === undefined) throw new Error(`No default address for ${d.name}`);
      return [d.name, { kind: d.name, base_url: base, key_env: d.keyName }];
    })),
  },
});

const usagePricing = yaml<{ models: Record<string, Record<string, number>> }>("config/usage-pricing.yaml");

/**
 * Direct prices of models that usage-pricing.yaml does not list because today
 * they are reached through OpenRouter only. Gemini 3.8 Flash reads media for
 * the element step; Google's paid-tier price through 2026-12-31 (it doubles
 * on 2027-01-01): https://ai.google.dev/gemini-api/docs/pricing
 */
const DIRECT_PRICES: Readonly<Record<string, Record<string, number>>> = {
  "google/gemini-3.8-flash": { input_cache_hit_per_mtok: 0.075, input_cache_miss_per_mtok: 0.75, output_per_mtok: 3.75 },
};
const flash = capture(llmSource, /modelId === "([^"]+)" \? "[^"]+"/);
const flashOnDeepseek = capture(llmSource, /modelId === "[^"]+" \? "([^"]+)"/);
write("llm.yaml", `
Where LLM calls go (design 4.3). A model id takes the first route whose prefix
it starts with; within a route the configured upstream of lowest weight is
tried first, and a call moves on before its first content when an upstream
has no key, cannot be reached, keeps answering 429 or 5xx, lacks the model,
or says its balance is exhausted.
understand_routes is the same for reading media, the official API first.
vendor_ids is the id an upstream serves one of our models under.
openrouter_backends pins the backend OpenRouter routes a model to. prices are
the direct token prices, in USD per million tokens, for upstreams that report
no cost of their own.
gemini_inline_max_bytes is the request size past which media goes to Gemini
through its Files API rather than inline; gemini_file_poll_ms is how often an
uploaded file is asked about until it is ready.
`, {
  routes: [
    ...direct.map((d) => ({ prefix: d.prefix, upstreams: [{ upstream: d.name, weight: 0 }, { upstream: "openrouter", weight: 1 }] })),
    { prefix: "", upstreams: [{ upstream: "openrouter", weight: 0 }] },
  ],
  understand_routes: [{ prefix: "google/", upstreams: [{ upstream: "google", weight: 0 }, { upstream: "openrouter", weight: 1 }] }],
  vendor_ids: { [`deepseek/${flash}`]: { deepseek: flashOnDeepseek } },
  openrouter_backends: {
    [describe.model]: { only: [capture("packages/domain/src/understand/types.ts", /backend: "([^"]+)"/)], allow_fallbacks: false },
  },
  prices: { ...usagePricing.models, ...DIRECT_PRICES },
  gemini_inline_max_bytes: 20_000_000,
  gemini_file_poll_ms: 5_000,
});

write("routing.yaml.template", `
This deployment's own upstream weights (design 4.4). Copy this file to
config/provider/routing.yaml and change the weights there; the copy is not
shipped. Without it every model keeps the weights in media/*.yaml and
llm.yaml. Overrides change weights only: naming an upstream a model or route
is not bound to is refused at startup, and so is a weight used twice. llm
overrides llm.yaml's routes, understand its understand_routes, each by prefix.

models:
  seedance-2.5-text-to-video:
    weights: { wavespeed: 0 }
llm:
  deepseek/:
    weights: { openrouter: 0, deepseek: 1 }
understand:
  google/:
    weights: { google: 0, openrouter: 1 }
`, null);

process.stdout.write("config/provider written\n");
