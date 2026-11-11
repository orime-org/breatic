// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Model catalog — loads all AIGC model configs from YAML.
 *
 * Reads config/models/{modality}/*.yaml at startup and serves a cached catalog for the API, each model with what
 * provider says about it: which upstreams can serve it here and its pricing on each.
 * @module
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { parse } from "yaml";
import { env, MONOREPO_ROOT } from "@breatic/core";
import {
  violatesReferenceCount,
  type ReferenceCountViolation,
} from "@domain/model-catalog/reference-count.js";
import {
  assertModesDeclared,
  getModeConfig,
  resetModeConfig,
} from "@domain/model-catalog/mode-config.js";
import { assertNamesTellApart } from "@domain/model-catalog/model-names.js";
import { assertParamDeclarations } from "@domain/model-catalog/param-declaration.js";
import { assertForces } from "@domain/model-catalog/forces.js";
import { assertTakesPromptDeclared } from "@domain/model-catalog/takes-prompt.js";
import {
  assertCameraCommands,
  shipCameraCommands,
  type DeclaredCameraCommand,
} from "@domain/model-catalog/camera-commands.js";
import { assertCameraAngle, shipCameraAngle } from "@domain/model-catalog/camera-angle.js";
import type {
  CameraAngleParams,
  ExtraStep,
  ModelCatalog,
  ModelEntry,
  ModelTier,
  ParamBound,
  ParamDescriptor,
  ParamForce,
  ParamGate,
  PricingContract,
  RemoteParamSource,
  SourceGroup,
} from "@breatic/shared";
import { extractPromptText, fitsSomeMode, promptTaken, resolveParams } from "@breatic/shared";
import { creditEstimateOf, prepareRunParams, type CreditEstimate, type EstimateInput } from "@breatic/shared/pricing";
import type { Route } from "@breatic/provider";
import { provider } from "@domain/provider/instance.js";

/** Root directory for model YAML configs. */
const MODELS_DIR = resolve(MONOREPO_ROOT, "config/models");

/** Supported modalities (subdirectory names). */
export const MODALITIES = ["image", "video", "audio", "tts", "three_d"] as const;
export type Modality = (typeof MODALITIES)[number];

// ModelTier / ParamDescriptor / ModelProvider / ModelEntry / ModelCatalog are
// the GET /models wire contract — they live in @breatic/shared (imported
// above) because the catalog RESPONSE is consumed by server (which builds it
// here) + web (which renders it). This module owns the YAML-loading + the
// runtime MODALITIES.

// ── Full config (backend-only, #1672) ────────────────────────────────

/** Full param spec as authored in yaml — backend-only superset of the wire ParamDescriptor. */
export interface FullParamSpec {
  type?: string;
  description?: string;
  values?: unknown[];
  /** The fields of one entry of a list param (`type: items`). */
  fields?: Record<string, { type?: string; values?: unknown[]; max_chars?: number }>;
  default?: unknown;
  min?: number;
  max?: number;
  max_items?: number;
  /** Another param this one stands in for; the body sends only one of the two. */
  replaces?: string;
  /** The value that is sent as nothing: holding it leaves the param out. */
  absent_value?: string | number | boolean;
  /** The upstream field this param is sent as, when it is not the param's name. */
  upstream?: string;
  /** What a value is sent as upstream, keyed by the value's string form. */
  upstream_values?: Record<string, string>;
  /** The template each entry of a list is written into the prompt with. */
  into_prompt?: string;
  /** How the param's value reaches the run. */
  fill?: string;
  /** What has to hold before this param counts; dropped from the run otherwise. */
  when?: ParamGate;
  /** Ranges that replace `min` and `max` while their condition holds (inner#1691). */
  bounds?: ParamBound[];
  /** The most characters a text param takes once cleaned (inner#1691). */
  max_length?: number;
  /**
   * Names the picker that fills this param, for params whose value domain
   * lives upstream instead of in `values` (#1960). Projected onto the wire
   * `ParamDescriptor` unchanged.
   */
  remote_source?: RemoteParamSource;
  [extra: string]: unknown;
}

/** One provider endpoint on a model with every yaml field preserved (backend-only). */
export interface FullProviderEndpoint {
  name: string;
  model_id: string;
  priority?: number;
  /** The endpoint's WaveSpeed pricing contract. */
  pricing?: PricingContract;
  [extra: string]: unknown;
}

/** One model entry with every yaml field preserved (backend-only). */
export interface FullModelEntry {
  name: string;
  display_name?: string;
  /** What tells this model apart from another one sharing its name in some mode. */
  variant?: string;
  mode?: string | string[];
  tier?: string;
  description?: string;
  guide?: string;
  generation_time?: number;
  icon?: string;
  /**
   * Whether this model consumes the text the user writes (#1966). Optional
   * HERE because this interface mirrors what is literally on disk, and a yaml
   * file can omit it — `assertTakesPromptDeclared` is what makes omission an
   * error, so the wire type (`ModelEntry.takes_prompt`) can be non-optional.
   */
  takes_prompt?: boolean;
  /** The upstream field the prompt is sent as, when it is not `prompt`. */
  prompt_upstream?: string;
  /** Upstream calls a run makes besides the model's own. */
  extra_steps?: ExtraStep[];
  /** The param whose source, once sent, lets later runs skip the model's own call. */
  reused_by?: string;
  /** Per mode, params of which at least one has to carry material. */
  source_groups?: SourceGroup[];
  /**
   * How much input text this model accepts in one request (#1960). Optional:
   * absent when the upstream publishes no cap.
   */
  max_input_chars?: number;
  /**
   * The longest side, in pixels, of a picture this model is known to take and
   * answer at its own size (inner#1303); absent when none was measured.
   */
  max_output_side?: number;
  /**
   * The media type this model returns, when not its modality's usual one
   * (inner#1305); the worker stores the result under it.
   */
  output_type?: string;
  /** The camera commands this model reads out of its prompt. */
  camera_commands?: DeclaredCameraCommand[];
  /** Values the model forces while their conditions hold, in order (inner#1691). */
  forces?: ParamForce[];
  /** The most characters the prompt takes once cleaned (inner#1691). */
  prompt_max_length?: number;
  /** The condition the prompt is taken under, read through shared `promptTaken`. */
  prompt_when?: ParamGate;
  /** The three params that together set one camera pose (inner#830). */
  camera_angle?: CameraAngleParams;
  params?: Record<string, FullParamSpec>;
  providers?: FullProviderEndpoint[];
  /**
   * The voices a tts model writes inline, for a deployment behind a gateway
   * with no voice endpoint of its own (#1960). `sample_url` may be null: yaml
   * states absence that way, and this interface mirrors what is on disk.
   *
   * `id` is what travels to the vendor and `name` is what a person reads;
   * they are separate because the vendor's ids are opaque (#2086).
   */
  voices?: Array<{
    id: string;
    name?: string;
    gender?: string;
    description?: string;
    sample_url?: string | null;
    /** A sample we generated, as a path under config/voice-samples.json's `base_url` (#2156, #2239). */
    sample_key?: string;
    /** Generated samples by language value, for a voice that speaks any of them. */
    sample_keys?: Record<string, string>;
  }>;
  [extra: string]: unknown;
}

/**
 * Connection config for one provider from providers.yaml. Carries secrets
 * plumbing (api_key_env) and vendor endpoints — backend-only; must never be
 * projected into `@breatic/shared` or any web-facing response.
 */
export interface ProviderConnectionConfig {
  base_url?: string;
  api_key_env?: string;
  max_concurrency?: number;
  [extra: string]: unknown;
}

/** Full config for one modality: all models plus provider connection configs. */
export interface FullModalityConfig {
  models: FullModelEntry[];
  providers: Record<string, ProviderConnectionConfig>;
}

const _fullConfigCache = new Map<string, FullModalityConfig>();

/**
 * Load the complete, unprojected model config for one modality.
 *
 * Domain is the single config/models YAML reader (#1672): the catalog
 * projections below and the worker's resolveModel/validateParams all
 * consume this accessor instead of parsing YAML themselves. Results are
 * cached per modality; {@link resetModelCatalog} clears the cache.
 * @param modality - Modality directory name (e.g. "image"); unknown values yield an empty config
 * @returns Models with every yaml field plus provider connection configs
 * @throws {Error} when a yaml file is malformed (fail-fast; the application boot path logs)
 */
export function getFullModelConfig(modality: string): FullModalityConfig {
  const cached = _fullConfigCache.get(modality);
  if (cached) return cached;

  const dir = resolve(MODELS_DIR, modality);
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => extname(f) === ".yaml" && f !== "providers.yaml")
      .sort();
  } catch {
    // Unknown modality / missing directory — an empty config lets callers
    // fail with their own "model not found" semantics.
    return { models: [], providers: {} };
  }

  const models: FullModelEntry[] = [];
  for (const file of files) {
    const parsed = parse(readFileSync(resolve(dir, file), "utf-8")) as {
      models?: FullModelEntry[];
    } | null;
    if (parsed?.models) models.push(...parsed.models);
  }

  // #1966: refuse the whole modality rather than let one silent `undefined`
  // become `false` downstream. The two entries that can reach this catalog —
  // server and worker — preheat it at startup, so a typo surfaces when the
  // deployment starts instead of under whoever first opens a Generate panel.
  // Collab is the third service entry and does neither: it is barred from
  // importing `@breatic/domain` at all (`collab-no-domain-import`), and it
  // serves no AIGC path that would read a model.
  assertTakesPromptDeclared(modality, models);
  // The mode says what material a run needs and the parameters say which of
  // this model's fields carry it, so a model naming a mode with no row, or a
  // field declaring something the model denies, leaves a question every
  // reader answers on its own. Same fail-fast reasoning as the line above.
  assertModesDeclared(modality, models, getModeConfig());
  assertParamDeclarations(modality, models);
  assertForces(modality, models);
  assertNamesTellApart(modality, models);
  assertCameraCommands(modality, models);
  assertCameraAngle(modality, models);

  let providers: Record<string, ProviderConnectionConfig> = {};
  const providersPath = resolve(dir, "providers.yaml");
  if (existsSync(providersPath)) {
    providers =
      (parse(readFileSync(providersPath, "utf-8")) as Record<string, ProviderConnectionConfig>) ??
      {};
  }

  const config = { models, providers };
  _fullConfigCache.set(modality, config);
  return config;
}

/**
 * Project a full yaml model entry onto the shared wire {@link ModelEntry},
 * dropping `note` (it is for whoever ships the yaml) and what goes upstream,
 * with provider's availability and pricing rules of the model.
 * @param m - Full model entry from {@link getFullModelConfig}.
 * @param modality - Modality the entry belongs to (stamped onto the projection).
 * @returns The wire-facing catalog entry.
 */
function projectModelEntry(m: FullModelEntry, modality: Modality): ModelEntry {

  return {
    name: m.name,
    display_name: m.display_name ?? m.name,
    ...(m.variant !== undefined ? { variant: m.variant } : {}),
    modality,
    mode: m.mode as string | string[],
    description: m.description ?? "",
    guide: m.guide ?? "",
    tier: (m.tier as ModelTier) ?? "optional",
    generation_time: m.generation_time ?? 60,
    // Same blind cast as the yaml guidelines promise (every param has
    // description + default); FullParamSpec keeps them optional because it
    // mirrors what is literally on disk. `note` stays behind: it says why a
    // declaration has no control, which is for whoever ships the yaml.
    params: Object.fromEntries(
      Object.entries(m.params ?? {}).map(([name, spec]) => {
        const { note: _note, upstream: _upstream, upstream_values: _values, item_key: _itemKey, ...rest } = spec;
        return [name, rest as unknown as ParamDescriptor];
      }),
    ),
    availability: provider().availability(m.name),
    pricing_rules: provider().pricingRules(m.name),
    // #1966: declared per model in yaml, never derived. The loader has
    // already refused any modality where a model omits it, so the wire
    // field is a plain boolean the panels can read without a fallback.
    takes_prompt: m.takes_prompt as boolean,
    source_groups: m.source_groups,
    // #1960: how much text this model takes, so the panel can say so before
    // sending text the upstream will reject. Absent on models whose upstream
    // publishes no cap.
    max_input_chars: m.max_input_chars,
    // The longest side the expand tool may grow a picture to (inner#1303).
    max_output_side: m.max_output_side,
    output_type: m.output_type,
    camera_commands: shipCameraCommands(m.camera_commands),
    camera_angle: shipCameraAngle(m.camera_angle),
    icon: m.icon,
    // The panel locks and the run resolves by these, the same as every reader (inner#1691).
    forces: m.forces,
    prompt_max_length: m.prompt_max_length,
    prompt_when: m.prompt_when,
  };
}

let _cache: ModelCatalog | null = null;

/**
 * Load the full model catalog from YAML configs.
 *
 * Results are cached after first load. Every model is listed, one no upstream can serve here included: its
 * availability names the environment variables its keys are missing from, and a run of it is refused before it is
 * queued, saying which (inner#1743). Availability asks only whether the variable is non-empty, never whether the
 * key works.
 * @returns Complete model catalog grouped by modality
 */
export function getModelCatalog(): ModelCatalog {
  if (_cache) return _cache;

  const catalog: Record<Modality, ModelEntry[]> = {
    image: [],
    video: [],
    audio: [],
    tts: [],
    three_d: [],
  };

  for (const modality of MODALITIES) {
    // Per `AGENTS.md#library-packages-do-not-log`, parse
    // errors throw inside getFullModelConfig so the application boot path
    // catches + logs with the right context (catalog load is at server
    // startup — a malformed YAML should fail-fast, not silently drop the
    // affected modality).
    catalog[modality] = getFullModelConfig(modality).models.map((m) =>
      projectModelEntry(m, modality),
    );
  }

  const total = MODALITIES.reduce((sum, m) => sum + catalog[m].length, 0);

  const built: ModelCatalog = { ...catalog, total, credit_multiplier: env.CREDIT_MULTIPLIER };
  _cache = built;
  return built;
}

/**
 * Floor a task's pre-check estimate never goes below. Also the flat
 * requirement for tasks whose model (and therefore `cost_per_call`) is
 * unknown at enqueue time — mini-tools. One shared
 * number so the /canvas/tasks and /mini-tools pre-checks can never drift.
 */
export const MIN_TASK_CREDIT_COST = 5;

/**
 * Pre-check cost estimate for a task (#1580 #7 credit pre-check, user
 * decision 2026-07-03: server refuses obviously-insufficient balances
 * BEFORE enqueue; the check is NON-LOCKING — the worker still bills the
 * actual usage at completion, and two tasks passing the pre-check
 * concurrently may drive the balance negative, an accepted trade-off of
 * a soft pre-check).
 *
 * Prices the run the request describes on the upstream its route would choose. The
 * server does not know how long a source is, so a formula billed by source
 * length prices it at zero: the answer is a lower bound, which is what a gate
 * refusing broke requests needs. Unknown / unspecified models and models no
 * upstream can price fall back to {@link MIN_TASK_CREDIT_COST}, which is also the
 * floor.
 * @param model - Model name from the request body, if any.
 * @param input - The run as the request describes it: params keyed by the
 *   catalog's names, the prompt, and the source lengths the caller knows.
 * @param route - How the run chooses its upstream, the same value the task carries.
 * @returns The credits the caller must at least hold to enqueue.
 * @throws {Error} When a pricing formula does not produce a finite price.
 */
export async function estimateTaskCredits(
  model: string | undefined,
  input: EstimateInput,
  route?: Route,
): Promise<number> {
  const estimate = model ? await estimateModelCredits(model, input, route) : undefined;
  return Math.max(estimate?.credits ?? 0, MIN_TASK_CREDIT_COST);
}

/**
 * One run of a catalog model, priced the way the panels price it: on its params as the run resolves them, so what
 * its settings do not send is not priced, prepared by shared's `prepareRunParams` and priced by provider on the
 * upstream the route would choose.
 * @param model - Model name.
 * @param input - The run as set up so far; `{ params: {} }` prices the defaults.
 * @param route - How the run chooses its upstream; the weights when left out.
 * @returns The credits and how they bound the charge, or undefined for a model
 *   not in the catalog or one no upstream here can serve.
 * @throws {Error} When a pricing formula does not produce a finite price.
 */
export async function estimateModelCredits(
  model: string,
  input: EstimateInput,
  route: Route = { mode: "default" },
): Promise<CreditEstimate | undefined> {
  const entry = findCatalogEntry(model);
  if (entry === undefined) return undefined;
  const prepared = prepareRunParams(entry, { ...input, params: resolveParams(entry, input.params) });
  return creditEstimateOf(await provider().estimate(model, prepared, route), env.CREDIT_MULTIPLIER);
}

/** Whether a run of a model can be served here on its route, and if not, why. */
export type Servability =
  | { servable: true }
  /** The route names an upstream the model has no binding on. */
  | { servable: false; reason: "unbound"; upstream: string }
  /** No upstream the route may use has its key: the environment variables they read, in weight order. */
  | { servable: false; reason: "unconfigured"; envVars: string[] };

/**
 * Whether a run of a model can be served here on its route: one upstream the route may use has its key.
 * @param model - Model name.
 * @param route - How the run chooses its upstream; the weights when left out.
 * @returns Servable, or why not.
 */
export function servability(model: string, route: Route = { mode: "default" }): Servability {
  const { upstreams } = provider().availability(model);
  const pool = route.mode === "upstream" ? upstreams.filter((u) => u.upstream === route.upstream) : upstreams;
  if (route.mode === "upstream" && pool.length === 0) return { servable: false, reason: "unbound", upstream: route.upstream };
  if (pool.some((u) => u.configured)) return { servable: true };
  return { servable: false, reason: "unconfigured", envVars: pool.map((u) => u.envVar) };
}

/**
 * Whether a language model's calls of one use can be served here: one upstream of the routes that use takes has its
 * key.
 * @param model - Our model id.
 * @param use - `call` for chat, consolidation and the text tools; `understand` for reading media.
 * @returns Servable, or the environment variables none of those upstreams has.
 */
export function llmServability(model: string, use: "call" | "understand"): Servability {
  const { upstreams } = provider().llm.availability(model, use);
  if (upstreams.some((u) => u.configured)) return { servable: true };
  return { servable: false, reason: "unconfigured", envVars: upstreams.map((u) => u.envVar) };
}

/**
 * The catalog entry of a model this deployment serves.
 * @param model - Model name.
 * @returns The entry, or undefined when no modality carries it.
 */
function findCatalogEntry(model: string): ModelEntry | undefined {
  const catalog = getModelCatalog();
  for (const modality of MODALITIES) {
    const entry = catalog[modality].find((m) => m.name === model);
    if (entry) return entry;
  }
  return undefined;
}

/**
 * #1675 server execute gate: whether a submission makes a valid run of none
 * of the model's modes. The /canvas/tasks route runs this BEFORE enqueue, so a
 * run the upstream would reject never becomes a task row or a job. Defence in
 * depth behind the panel's gate, which asks the same `missingSources` for the
 * one mode it is in; the request carries no mode, so any mode will do here.
 * An unknown or absent model passes: existence is not this gate's job.
 * @param model - The task's model name from the request body, if any.
 * @param params - The task params, keyed by the catalog's names.
 * @returns True when no mode of the model has what it needs.
 */
export function violatesSourceRequirementForModel(
  model: string | undefined,
  params: Record<string, unknown>,
): boolean {
  const entry = model ? findCatalogEntry(model) : undefined;
  if (!entry) return false;
  const modes = Array.isArray(entry.mode) ? entry.mode : [entry.mode];
  return !fitsSomeMode(entry, modes, params);
}

/**
 * Server gate beside the source check (breatic#1393): whether a submitted run
 * carries a prompt its model does not take with these settings, as Mureka V9.5
 * Song composing from a melody. The panel neither shows nor sends the style box
 * then, so a request carrying one came from elsewhere (the Agent, or crafted).
 * The client narrows params to the run's mode before submitting, so they are
 * read as they come. An unknown or absent model passes.
 * @param model - The task's model name from the request body, if any.
 * @param params - The task params, the prompt under `prompt`.
 * @returns True when a non-empty prompt goes to a run that takes none.
 */
export function sendsUntakenPrompt(model: string | undefined, params: Record<string, unknown>): boolean {
  const entry = model ? findCatalogEntry(model) : undefined;
  if (!entry || typeof params.prompt !== "string" || extractPromptText(params.prompt) === "") return false;
  return !promptTaken(entry, undefined, params);
}

/**
 * #1735 server reference-count gate: whether the submitted params carry more
 * items in a capped list param than the model's `max_items` allows. The
 * /canvas/tasks route runs this BEFORE enqueue so an over-picked submission is
 * rejected (with a message naming the limit) rather than silently truncated by
 * the worker (providers/shared.ts). Sits at the same gate as
 * {@link violatesSourceRequirementForModel}, reading the model's per-param
 * `max_items` off the wire `ParamDescriptor`. An unknown / absent model
 * passes (existence is not this gate's job).
 * @param model - The task's model name from the request body, if any.
 * @param params - The task params (`params.images` etc. carry the capped lists).
 * @returns The first overflow (field + limit + actual), or null when within limits.
 */
export function violatesReferenceCountForModel(
  model: string | undefined,
  params: Record<string, unknown>,
): ReferenceCountViolation | null {
  if (!model) return null;
  const catalog = getModelCatalog();
  for (const modality of MODALITIES) {
    const entry = catalog[modality].find((m) => m.name === model);
    if (entry) return violatesReferenceCount(entry.params, params);
  }
  return null; // unknown model — existence is not this gate's job
}

/**
 * Hand back every cached answer the catalog carries (for testing).
 *
 * The mode layer goes with it: the catalog checks its models against
 * `modes.yaml`, so a reset that left that cache alone would check the new
 * models against the old modes, and the caller has no second reset to reach
 * for.
 */
export function resetModelCatalog(): void {
  _cache = null;
  _fullConfigCache.clear();
  resetModeConfig();
}
