// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Writes the provider package's configuration from today's catalog
 * (inner#1743), so the provider tests can prove the move changes
 * nothing: every catalog and 3D model bound to WaveSpeed at weight 1 with the
 * upstream fields, value spellings, extra steps and pricing the catalog
 * declares today (where WaveSpeed's own schema departs from them, the
 * `WAVESPEED` table below), the upstreams from `config/models/<modality>/providers.yaml`
 * and the LLM routes from `packages/domain/src/agent/llm.ts`.
 *
 * Run from the repository root with `pnpm exec tsx scripts/provider-config-migration.ts`.
 * It writes `config/provider/upstreams.yaml`, `config/provider/media/<modality>.yaml`,
 * `config/provider/llm.yaml` and `config/provider/routing.yaml.template`,
 * merging into the files already there (`scripts/provider-config-merge.mjs`):
 * it replaces only each model's WaveSpeed binding and its own upstream and LLM
 * entries, so reseller bindings and the 3D prices `pnpm provider:prices` wrote
 * survive a rerun.
 * It is a one-off: run it again when the catalog changes before the
 * application moves to the provider package, and delete it with the old
 * implementation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Document, parse } from "yaml";
import { mergeLlm, mergeMediaModels, mergeUpstreams } from "./provider-config-merge.mjs";
import { yamlText } from "./provider-yaml.mjs";

interface RawPricing { base_price: number; formula: string; discount_rate: number }
interface RawParam {
  upstream?: string;
  values?: (string | number | boolean)[];
  into_prompt?: string;
  upstream_values?: Record<string, string | number | boolean>;
  item_key?: string;
  absent_value?: string | number | boolean;
  mention?: string;
  joins?: string;
}
interface RawStep { endpoint: string; at: "before" | "after"; for_param?: string; per_item?: boolean; pricing: RawPricing }
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
 * Params the application layer turns into the prompt itself besides those
 * the catalog marks `into_prompt`: no upstream field carries them. Copied
 * from the families in `packages/worker/src/providers/families/`.
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

/** Why a param WaveSpeed has no field for is dropped whatever its value. */
const IGNORED = "WaveSpeed has no such field and ignores it, probed 2026-11-01";

/**
 * Where WaveSpeed departs from the catalog, by model, from its schemas
 * (`/api/v3/models`) and submits probed on 2026-11-01 (inner#1775, inner#1872,
 * inner#1873). `renames`: the catalog's field to the name WaveSpeed's schema
 * gives it (WaveSpeed takes both and echoes the schema's). `refuses`: the
 * catalog's values WaveSpeed rejects; the binding supports the others.
 * `drops`: params WaveSpeed has no field for and ignores, written as the
 * binding's `drops`: whatever the value, or only for the listed values when
 * another value asks for what WaveSpeed cannot do (a switch turned on that
 * fal serves). `noPrompt`: its schema has no prompt, and one sent is ignored.
 * `delisted`: WaveSpeed no longer serves the model, so it gets no WaveSpeed
 * binding (fal serves it). `modelId`: the id WaveSpeed lists the model under
 * when it is not the catalog's. `spellings`: a param's `values` and
 * `absent_value` where WaveSpeed's field takes other values than ours.
 * `rejects`: the limits WaveSpeed states beyond the model vendor's own (the
 * vendor's are the model's `rejects`), written as the binding's `rejects`. `mentions`: how WaveSpeed's schema names a
 * param's references in the prompt where the catalog's mention differs.
 */
const WAVESPEED: Readonly<Record<string, {
  renames?: Readonly<Record<string, string>>;
  refuses?: Readonly<Record<string, readonly (string | number | boolean)[]>>;
  drops?: Readonly<Record<string, readonly (string | number | boolean)[] | { all_values: string }>>;
  noPrompt?: true;
  delisted?: true;
  modelId?: string;
  spellings?: Readonly<Record<string, { values?: Readonly<Record<string, string>>; absent_value?: string | number | boolean }>>;
  rejects?: readonly { when: string; reason: string }[];
  mentions?: Readonly<Record<string, string>>;
}>> = {
  "flux-3-start-end-to-video": { renames: { start_image: "image", end_image: "last_image" } },
  "muse-image-edit": { renames: { image_urls: "images" }, refuses: { aspect_ratio: ["9:21"] } },
  "wan-3.0-text-to-video": { renames: { enable_audio: "generate_audio" } },
  "wan-3.0-image-to-video": { renames: { enable_audio: "generate_audio" } },
  "wan-3.0-reference-to-video": { renames: { enable_audio: "generate_audio" } },
  "wan-3.0-video-edit": { rejects: [{ when: "duration < 2 or duration > 15", reason: "WaveSpeed duration: Range: 2-15" }] },
  "hunyuan3d-v3": { refuses: { generate_type: ["LowPoly"] } },
  "hunyuan3d-v3-i23d": { refuses: { generate_type: ["LowPoly"] }, noPrompt: true },
  "hunyuan3d-v3.1-rapid": { noPrompt: true },
  "nano-banana-2-relight": { refuses: { output_format: ["webp"] } },
  "nano-banana-2-quick-edit": { refuses: { output_format: ["webp"] } },
  "elevenlabs-v3": { drops: { similarity: { all_values: IGNORED } } },
  "sfx-1.6-text-to-audio": {
    drops: { loop: [false], double_output: [false] },
    rejects: [{ when: "$length(text_prompt) < 4", reason: "WaveSpeed text_prompt minLength 4" }],
  },
  "minimax-h3-reference-to-video": {
    rejects: [{ when: "$exists(reference_audios) and $not($exists(reference_images) or $exists(reference_videos))", reason: "WaveSpeed reference_audios: Audio cannot be provided alone" }],
  },
  "krea-v2-large-text-to-image": { rejects: [{ when: "$length(prompt) > 5000", reason: "WaveSpeed prompt: Supports 1-5000 characters" }] },
  "gemini-omni-1.1-flash-reference-to-video": { mentions: { images: "<IMAGE_REF_{i}>", videos: "<VIDEO_REF_{i}>" } },
  "infinitetalk-video-to-video": { rejects: [{ when: "get_duration(audio) > 600", reason: "WaveSpeed audio: Max clip length per job: 10 minutes" }] },
  "ltx-2.3-lipsync": {
    rejects: [
      { when: "get_duration(audio) > 20", reason: "WaveSpeed audio: Audio duration must be between 5-20 seconds" },
      { when: "get_duration(audio, min=5, max=1000000, total=1000000) > get_duration(audio)", reason: "WaveSpeed audio: Audio duration must be between 5-20 seconds" },
    ],
  },
  "seedvr2-video": { rejects: [{ when: "get_duration(video) > 600", reason: "WaveSpeed video: Max clip length per job: up to 10 minutes" }] },
  "rife-interpolation": { rejects: [{ when: "get_duration(video) > 600", reason: "WaveSpeed video: The maximum supported video duration is 10 minutes" }] },
  // Relisted as meshy/v6/text-to-3d (/api/v3/models, 2026-11-03); the old id stays delisted.
  "meshy6-t23d": {
    modelId: "meshy/v6/text-to-3d",
    renames: { ta_pose: "pose_mode" },
    spellings: { ta_pose: { values: { true: "t-pose" }, absent_value: false } },
    drops: { art_style: { all_values: "WaveSpeed's schema has no such field; Meshy deprecated art_style (docs.meshy.ai/en/api/text-to-3d)" } },
    rejects: [{ when: "$length(prompt) > 600", reason: "WaveSpeed prompt maxLength 600" }],
  },
  "veed-clean-audio": { delisted: true },
  "recraft-v4-style-text-to-image": { delisted: true },
  "sfx-1.6-extend-audio": { delisted: true },
};

/** Params whose value the upstream takes in its own shape. */
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
 * A yaml file under `config/provider/` as it is now.
 * @param path - The path below `config/provider/`.
 * @returns Its content, or undefined when it does not exist yet.
 */
function current<T>(path: string): T | undefined {
  const file = resolve(ROOT, "config/provider", path);
  return existsSync(file) ? (parse(readFileSync(file, "utf8")) as T) : undefined;
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
  const body = content === null ? "" : yamlText(new Document(content), { lineWidth: 0 });
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
 * One model's WaveSpeed binding, without `pricing` when the catalog has no WaveSpeed contract for it.
 * @param model - The catalog entry.
 * @param threeD - Whether it is a 3D model, whose family passes every param through.
 * @returns The binding.
 * @throws {Error} When the model has no WaveSpeed provider.
 */
function bindingOf(model: RawModel, threeD: boolean): Record<string, unknown> {
  const provider = model.providers?.find((p) => p.name === "wavespeed");
  if (provider === undefined) throw new Error(`${model.name} has no WaveSpeed provider`);
  const skipped = new Set(APP_PARAMS[model.name] ?? []);
  const facts = WAVESPEED[model.name] ?? {};
  const params: Record<string, Record<string, unknown>> = {};
  const mentions: Record<string, string> = {};
  const drops: Record<string, NonNullable<(typeof facts)["drops"]>[string] | "*"> = {};
  for (const [name, spec] of Object.entries(model.params ?? {})) {
    const mention = facts.mentions?.[name] ?? spec.mention;
    if (mention !== undefined) mentions[name] = mention;
    // A slot that joins a pool travels inside it; no field carries the slot itself.
    if (skipped.has(name) || spec.into_prompt !== undefined || spec.joins !== undefined) {
      drops[name] = "*";
      continue;
    }
    const dropped = facts.drops?.[name];
    if (dropped !== undefined) {
      drops[name] = dropped;
      continue;
    }
    const transform = TRANSFORMS[model.name]?.[name];
    const field = threeD ? name : (spec.upstream ?? name);
    const refused = facts.refuses?.[name];
    params[name] = {
      field: facts.renames?.[field] ?? field,
      ...(refused === undefined ? {} : { supported: (spec.values ?? []).filter((v) => !refused.includes(v)) }),
      ...(spec.upstream_values === undefined ? {} : { values: spec.upstream_values }),
      ...(spec.item_key === undefined ? {} : { item_key: spec.item_key }),
      ...(spec.absent_value === undefined ? {} : { absent_value: spec.absent_value }),
      ...(transform === undefined ? {} : { transform }),
      ...facts.spellings?.[name],
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
      ...(kind === "element" ? { describe } : {}),
      pricing: pricingOf(step.pricing),
    };
  });
  return {
    upstream: "wavespeed",
    weight: 1,
    model_id: facts.modelId ?? provider.model_id,
    // Today's 3D path sends the prompt on every call, "" when there is none, and drops only null params.
    ...(threeD ? { ...(facts.noPrompt ? {} : { prompt_field: "prompt" }), send_empty: true } : model.takes_prompt === true ? { prompt_field: model.prompt_upstream ?? "prompt" } : {}),
    ...(Object.keys(params).length === 0 ? {} : { params }),
    ...(Object.keys(drops).length === 0 ? {} : { drops }),
    ...(steps.length === 0 ? {} : { extra_steps: steps }),
    ...(model.reused_by === undefined ? {} : { reused_by: model.reused_by }),
    ...(Object.keys(mentions).length === 0 ? {} : { mentions }),
    ...(facts.rejects === undefined ? {} : { rejects: facts.rejects }),
    ...(provider.pricing === undefined ? {} : { pricing: pricingOf(provider.pricing) }),
  };
}

/**
 * The flat price a model without a WaveSpeed contract stands in with until `pnpm provider:prices`
 * writes its real one: 3D models carry only a per-call credit figure (cents).
 * @param model - The catalog entry.
 * @returns The rule, or undefined when the model has no such figure.
 */
function placeholderOf(model: RawModel): Record<string, unknown> | undefined {
  return model.cost_per_call === undefined ? undefined : pricingOf({ base_price: model.cost_per_call * 10_000, formula: "", discount_rate: 100 });
}

const MEDIA_HEADER = `
Where each of our {modality} models runs, upstream by upstream.
Weight is priority: the lowest configured weight is tried first, and weights
are unique per model. Each binding names the upstream's model id, the field
the prompt goes in (\`send_empty\` sends it and every param even when empty),
and how each of our params is written there: \`field\`,
\`values\` (our value to the upstream's spelling), \`item_key\` (each list
entry wrapped under it), \`absent_value\` (holding it sends nothing) and
\`transform\`. A param this upstream has no field for is listed in \`drops\`:
"*" serves the run whatever the value. \`mentions\` is
how the prompt names a param's sources there ({n} counts from 1, {i} from 0).
\`pricing\` is the upstream's contract: base_price in millionths of a USD, a
JSONata formula (empty means base_price per call), discount_rate the percentage
of the price charged (100 is full price).
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
  const placeholders: Record<string, unknown> = {};
  for (const file of files) {
    for (const model of yaml<{ models: RawModel[] }>(file).models) {
      // An empty list makes the merge remove the WaveSpeed binding the model had.
      models[model.name] = { upstreams: WAVESPEED[model.name]?.delisted ? [] : [bindingOf(model, modality === "three_d")] };
      const placeholder = placeholderOf(model);
      if (placeholder !== undefined) placeholders[model.name] = placeholder;
    }
  }
  const path = `media/${modality}.yaml`;
  const merged = mergeMediaModels(current<{ models: typeof models }>(path)?.models, models, placeholders);
  write(path, MEDIA_HEADER.replace("{modality}", modality.replace("_", " ")), { models: merged });
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
Every upstream provider reaches: the adapter kind that speaks to
it, its address, the environment variable that holds its key, and for media
upstreams how many requests one process sends it at once. An upstream whose
key variable is empty is skipped, and the call says which variable is missing.
`, {
  upstreams: mergeUpstreams(current<{ upstreams: Record<string, unknown> }>("upstreams.yaml")?.upstreams, {
    wavespeed: { kind: "wavespeed", base_url: wavespeed.base_url, key_env: wavespeed.api_key_env, concurrency: [...concurrency][0] },
    openrouter: { kind: "openrouter", base_url: "https://openrouter.ai/api/v1", key_env: capture(llmSource, /FALLBACK_ROUTE: Route = \{\s*keyName: "([^"]+)"/) },
    ...Object.fromEntries(direct.map((d) => {
      const base = SDK_BASE_URLS[d.name];
      if (base === undefined) throw new Error(`No default address for ${d.name}`);
      return [d.name, { kind: d.name, base_url: base, key_env: d.keyName }];
    })),
  }),
});

const usagePricing = yaml<{ models: Record<string, Record<string, number>> }>("config/usage-pricing.yaml");

/**
 * Direct prices of models that usage-pricing.yaml does not list because today
 * they are reached through OpenRouter only, each a list whose later entries
 * take effect at their `from`. Gemini 3.8 Flash reads media for the element
 * step; Google's paid-tier price is "$0.75 through December 31, 2026. $1.50
 * starting January 1, 2027." (input; output and cached input double the same
 * way): https://ai.google.dev/gemini-api/docs/pricing
 */
const DIRECT_PRICES: Readonly<Record<string, readonly Record<string, number | string>[]>> = {
  "google/gemini-3.8-flash": [
    { input_cache_hit_per_mtok: 0.075, input_cache_miss_per_mtok: 0.75, output_per_mtok: 3.75 },
    { from: "2027-01-01T00:00:00Z", input_cache_hit_per_mtok: 0.15, input_cache_miss_per_mtok: 1.5, output_per_mtok: 7.5 },
  ],
};
const flash = capture(llmSource, /modelId === "([^"]+)" \? "[^"]+"/);
const flashOnDeepseek = capture(llmSource, /modelId === "[^"]+" \? "([^"]+)"/);
write("llm.yaml", `
Where LLM calls go. A model id takes the first route whose prefix
it starts with; within a route the configured upstream of lowest weight is
tried first, and a call moves on before its first content when an upstream
has no key, cannot be reached, keeps answering 408, 409, 429 or 5xx, lacks the model,
or says its balance is exhausted.
understand_routes is the same for reading media, the official API first.
vendor_ids is the id an upstream serves one of our models under.
openrouter_backends pins the backend OpenRouter routes a model to. prices are
the direct token prices, in USD per million tokens, for upstreams that report
no cost of their own. openrouter_prices are OpenRouter's token prices for the
same models, as pnpm provider:prices writes them, so a cheapest call can rank
OpenRouter beside the direct upstream; both read only the endpoints of the
quantizations openrouter_quantizations lists.
gemini_inline_max_bytes is the request size past which media goes to Gemini
through its Files API rather than inline; gemini_file_poll_ms is how often an
uploaded file is asked about until it is ready.
`, mergeLlm(current<Record<string, unknown>>("llm.yaml"), {
  routes: [
    ...direct.map((d) => ({ prefix: d.prefix, upstreams: [{ upstream: d.name, weight: 0 }, { upstream: "openrouter", weight: 1 }] })),
    { prefix: "", upstreams: [{ upstream: "openrouter", weight: 0 }] },
  ],
  understand_routes: [{ prefix: "google/", upstreams: [{ upstream: "google", weight: 0 }, { upstream: "openrouter", weight: 1 }] }],
  vendor_ids: { [`deepseek/${flash}`]: { deepseek: flashOnDeepseek } },
  openrouter_backends: {
    [describe.model]: { only: [capture("packages/domain/src/understand/types.ts", /backend: "([^"]+)"/)], allow_fallbacks: false },
  },
  prices: { ...Object.fromEntries(Object.entries(usagePricing.models).map(([model, price]) => [model, [price]])), ...DIRECT_PRICES },
  gemini_inline_max_bytes: 20_000_000,
  gemini_file_poll_ms: 5_000,
}));

write("routing.yaml.template", `
This deployment's own upstream weights. Copy this file to
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
