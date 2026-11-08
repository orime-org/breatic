// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Writes the provider package's configuration from today's catalog
 * (inner#1743), so the provider tests can prove the move changes
 * nothing: every catalog model bound to WaveSpeed at weight 1 with the
 * upstream fields, value spellings, extra steps and pricing the catalog
 * declares today (where WaveSpeed's own schema departs from them, the
 * `WAVESPEED` table below), WaveSpeed's upstream from `config/models/<modality>/providers.yaml`,
 * and the LLM upstreams (their key names) and routes from `packages/domain/src/agent/llm.ts`,
 * with each direct vendor's address from `SDK_BASE_URLS`.
 *
 * Run from the repository root with `pnpm exec tsx scripts/provider-config-migration.ts`.
 * It writes `config/provider/upstreams.yaml`, `config/provider/media/<modality>.yaml`,
 * `config/provider/llm.yaml` and `config/provider/routing.yaml.template`,
 * merging into the files already there (`scripts/provider-config-merge.mjs`):
 * it replaces only each model's WaveSpeed binding and its own upstream and LLM
 * entries, so reseller bindings and the prices `pnpm provider:prices` wrote
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
 * (`/api/v3/models`) and probed submits (inner#1775, inner#1872,
 * inner#1873). `renames`: the catalog's field to the name WaveSpeed's schema
 * gives it (WaveSpeed takes both and echoes the schema's). `refuses`: the
 * catalog's values WaveSpeed rejects; the binding supports the others.
 * `drops`: params WaveSpeed has no field for and ignores, written as the
 * binding's `drops`: whatever the value, or only for the listed values when
 * another value asks for what WaveSpeed cannot do (a switch turned on that
 * fal serves).
 * `delisted`: WaveSpeed no longer serves the model, so it gets no WaveSpeed
 * binding (fal serves it).
 * `rejects`: the limits WaveSpeed states beyond the model vendor's own (the
 * vendor's are the model's `rejects`), written as the binding's `rejects`. `mentions`: how WaveSpeed's schema names a
 * param's references in the prompt where the catalog's mention differs.
 */
const WAVESPEED: Readonly<Record<string, {
  renames?: Readonly<Record<string, string>>;
  refuses?: Readonly<Record<string, readonly (string | number | boolean)[]>>;
  drops?: Readonly<Record<string, readonly (string | number | boolean)[] | { all_values: string }>>;
  delisted?: true;
  rejects?: readonly { when: string; reason: string }[];
  mentions?: Readonly<Record<string, string>>;
}>> = {
  "flux-3-start-end-to-video": { renames: { start_image: "image", end_image: "last_image" } },
  "muse-image-edit": { renames: { image_urls: "images" }, refuses: { aspect_ratio: ["9:21"] } },
  "wan-3.0-text-to-video": { renames: { enable_audio: "generate_audio" } },
  "wan-3.0-image-to-video": { renames: { enable_audio: "generate_audio" } },
  "wan-3.0-reference-to-video": { renames: { enable_audio: "generate_audio" } },
  "wan-3.0-video-edit": { rejects: [{ when: "duration < 2 or duration > 15", reason: "WaveSpeed duration: Range: 2-15" }] },
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
  // The catalog takes a face limit from 1; WaveSpeed's schema from 48. Only a number is compared: the frozen estimate
  // cases (upstream-estimate.json) fill a param without a default with text, which today's WaveSpeed price never reads.
  ...Object.fromEntries(["tripo-h3.1-t23d", "tripo-h3.1-i23d", "tripo-h3.1-multiview"].map((model) => [model, { rejects: [{ when: "$type(face_limit) = \"number\" and face_limit < 48", reason: "WaveSpeed face_limit: minimum 48" }] }])),
  "veed-clean-audio": { delisted: true },
  "recraft-v4-style-text-to-image": { delisted: true },
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
  const body = content === null ? "" : yamlText(new Document(content, { aliasDuplicateObjects: false }), { lineWidth: 0 });
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
 * @returns The binding.
 * @throws {Error} When the model has no WaveSpeed provider or no price.
 */
function bindingOf(model: RawModel): Record<string, unknown> {
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
    const field = spec.upstream ?? name;
    const refused = facts.refuses?.[name];
    params[name] = {
      field: facts.renames?.[field] ?? field,
      ...(refused === undefined ? {} : { supported: (spec.values ?? []).filter((v) => !refused.includes(v)) }),
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
      ...(kind === "element" ? { describe } : {}),
      pricing: pricingOf(step.pricing),
    };
  });
  const pricing = provider.pricing;
  if (pricing === undefined) throw new Error(`${model.name} has no price`);
  return {
    upstream: "wavespeed",
    weight: 1,
    model_id: provider.model_id,
    ...(model.takes_prompt === true ? { prompt_field: model.prompt_upstream ?? "prompt" } : {}),
    ...(Object.keys(params).length === 0 ? {} : { params }),
    ...(Object.keys(drops).length === 0 ? {} : { drops }),
    ...(steps.length === 0 ? {} : { extra_steps: steps }),
    ...(model.reused_by === undefined ? {} : { reused_by: model.reused_by }),
    ...(Object.keys(mentions).length === 0 ? {} : { mentions }),
    ...(facts.rejects === undefined ? {} : { rejects: facts.rejects }),
    pricing: pricingOf(pricing),
  };
}

const MEDIA_HEADER = `
Where each of our {modality} models runs, upstream by upstream.
Weight is priority: the lowest configured weight is tried first, and weights
are unique per model. A model's \`rejects\` are its vendor's own input limits,
in our param names (the prompt as \`prompt\`), each with the vendor's words as
\`reason\`, the vendor page as \`source\` and, for a limit announced for a date,
\`from\`; no upstream takes a run past them. Each binding names the upstream's
model id, the field the prompt goes in (\`send_empty\` sends it and every param
even when empty), and how each of our params is written there: \`field\` (dots
write under nested objects), \`values\` (our value to the upstream's spelling),
\`as\` (a string, a number or a one-item list), \`supported\` (the only values
this upstream takes), \`item_fields\` (the sub-fields of each item of a list),
\`item_key\` (each list entry wrapped under it), \`absent_value\` (holding it
sends nothing), \`unset\` (written when the run leaves it out) and \`transform\`.
A param this upstream has no field for is listed in \`drops\`: "*" serves the
run whatever the value, a list of values that send nothing serves only those,
{ values, equivalent } serves those values for the reason given and
{ all_values } any value for the reason given. \`fixed\` fields are sent on
every call, \`voice_map\` maps our voices to the upstream's, \`output_field\` is
where a fal result puts its files, \`extra_steps\` and \`reused_by\` are the
upstream's further calls, and the binding's \`rejects\` hold only what this
upstream enforces beyond the vendor. \`mentions\` is
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
  ["three_d", ["config/models/three_d/models.yaml"]],
];
for (const [modality, files] of sources) {
  const models: Record<string, { upstreams: Record<string, unknown>[] }> = {};
  for (const file of files) {
    for (const model of yaml<{ models: RawModel[] }>(file).models) {
      // An empty list makes the merge remove the WaveSpeed binding the model had.
      models[model.name] = { upstreams: WAVESPEED[model.name]?.delisted ? [] : [bindingOf(model)] };
    }
  }
  const path = `media/${modality}.yaml`;
  const merged = mergeMediaModels(current<{ models: typeof models }>(path)?.models, models);
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
billing_url is where a fal upstream's costs are read, its platform API;
empty_output_wait_ms is how long a SandBase run answered completed without
outputs is waited for.
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
/**
 * DeepSeek's off-peak discount, keyed by model (both DeepSeek models usage-pricing.yaml lists, at the peak rate). Its
 * pricing page (https://api-docs.deepseek.com/quick_start/pricing), footnote (2): "Off-peak rates are half of the peak
 * rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays.
 * All other hours are off-peak, including weekends and Chinese public holidays in full." The holidays are the Chinese
 * public holidays that fall on a weekday, from the State Council's yearly schedule (2027:
 * https://www.news.cn/politics/20261105/f90cd6ad4df94ab4833b141e52ccfc13/c.html); `pnpm provider:prices` reports a
 * list with no date in the current year (from 1 December, the next); add the next year's dates here.
 * @returns A fresh copy, so the yaml writer gives each model its own and no alias.
 */
const deepseekOffPeak = (): Record<string, unknown> => ({
  factor: 0.5,
  peak_utc: [{ days: [1, 2, 3, 4, 5], from: "01:00", to: "04:00" }, { days: [1, 2, 3, 4, 5], from: "06:00", to: "10:00" }],
  holidays: [
    "2027-01-01", "2027-02-05", "2027-02-08", "2027-02-09", "2027-02-10", "2027-02-11", "2027-02-12", "2027-04-05",
    "2027-05-03", "2027-05-04", "2027-05-05", "2027-06-09", "2027-09-15", "2027-10-01", "2027-10-04", "2027-10-05",
    "2027-10-06", "2027-10-07",
  ],
});
const OFF_PEAK: Readonly<Record<string, () => Record<string, unknown>>> = {
  "deepseek/deepseek-v4-pro": deepseekOffPeak,
  "deepseek/deepseek-v4.1-flash-1017": deepseekOffPeak,
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
no cost of their own: per model a list whose first price holds from the start
and each later one from its from (a UTC time), so an announced change is
written ahead; off_peak multiplies every price by its factor outside the
peak_utc windows (UTC weekdays, 0 is Sunday, and times) and on its holidays
(UTC dates). A call is priced at the moment the request that served it was
sent. openrouter_prices are OpenRouter's token prices for the
same models, as pnpm provider:prices writes them, so a cheapest call can rank
OpenRouter beside the direct upstream; both read only the endpoints of the
quantizations openrouter_quantizations lists, unknown only for a model none
of whose endpoints states a level. openrouter_states_quantization lists the
models one of whose endpoints does, priced or not.
openrouter_prices_at is when they were read: a direct price that took effect
after it is not ranked against them.
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
  prices: {
    ...Object.fromEntries(Object.entries(usagePricing.models).map(([model, price]) => [model, [{ ...price, ...(OFF_PEAK[model] === undefined ? {} : { off_peak: OFF_PEAK[model]() }) }]])),
    ...DIRECT_PRICES,
  },
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
