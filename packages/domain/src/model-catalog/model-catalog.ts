// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Model catalog — loads all AIGC model configs from YAML and filters by available API keys.
 *
 * Reads config/models/{modality}/*.yaml at startup, resolves provider availability
 * from environment variables, and serves a cached, filtered catalog for the API.
 * @module
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { parse } from "yaml";
import { env, MONOREPO_ROOT } from "@breatic/core";
import {
  computeSourcesByMode,
  violatesSourceRequirement,
} from "@domain/model-catalog/source-requirement.js";
import {
  violatesReferenceCount,
  type ReferenceCountViolation,
} from "@domain/model-catalog/reference-count.js";
import type {
  ModelCatalog,
  ModelEntry,
  ModelTier,
  ParamDescriptor,
} from "@breatic/shared";

/** Root directory for model YAML configs. */
const MODELS_DIR = resolve(MONOREPO_ROOT, "config/models");

/** Supported modalities (subdirectory names). */
const MODALITIES = ["image", "video", "audio", "tts", "three_d", "understand"] as const;
export type Modality = (typeof MODALITIES)[number];

// ModelTier / ParamDescriptor / ModelProvider / ModelEntry / ModelCatalog are
// the GET /models wire contract — they live in @breatic/shared (imported
// above) because the catalog RESPONSE is consumed by server (which builds it
// here) + web (which renders it). The worker never touches these heavy types:
// it calls listAvailableModels() below, which returns the lighter
// SkillModelInfo. This module owns the YAML-loading + the runtime MODALITIES.

// ── Full config (backend-only, #1672) ────────────────────────────────

/** Full param spec as authored in yaml — backend-only superset of the wire ParamDescriptor. */
export interface FullParamSpec {
  type?: string;
  description?: string;
  values?: unknown[];
  default?: unknown;
  min?: number;
  max?: number;
  max_items?: number;
  [extra: string]: unknown;
}

/** One provider endpoint on a model with every yaml field preserved (backend-only). */
export interface FullProviderEndpoint {
  name: string;
  model_id: string;
  priority?: number;
  token_price?: number;
  credit_price?: number;
  extra_params?: Record<string, unknown>;
  litellm_model?: string;
  [extra: string]: unknown;
}

/** One model entry with every yaml field preserved (backend-only). */
export interface FullModelEntry {
  name: string;
  display_name?: string;
  mode?: string | string[];
  tier?: string;
  description?: string;
  guide?: string;
  cost_per_call?: number;
  generation_time?: number;
  icon?: string;
  params?: Record<string, FullParamSpec>;
  providers?: FullProviderEndpoint[];
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
  timeout?: number;
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
 * Map provider name → env var name for API key lookup.
 * Built from each modality's provider connection configs.
 * @returns A map from provider name to its `api_key_env` variable name.
 */
function loadProviderKeyMap(): ReadonlyMap<string, string> {
  const keyMap = new Map<string, string>();

  for (const modality of MODALITIES) {
    for (const [name, config] of Object.entries(getFullModelConfig(modality).providers)) {
      if (config.api_key_env) {
        keyMap.set(name, config.api_key_env);
      }
    }
  }

  return keyMap;
}

/**
 * Check if a provider has an API key configured.
 * @param providerName - Name of the provider to check.
 * @param keyMap - Provider→env-var map from {@link loadProviderKeyMap}.
 * @returns `true` if the provider's API key env var is set to a non-empty string.
 */
function isProviderAvailable(providerName: string, keyMap: ReadonlyMap<string, string>): boolean {
  const envVar = keyMap.get(providerName);
  if (!envVar) return false;
  const value = (env as Record<string, unknown>)[envVar];
  return typeof value === "string" && value.length > 0;
}

/**
 * Project a full yaml model entry onto the shared wire {@link ModelEntry},
 * dropping backend-only fields (provider prices, extra_params, litellm ids)
 * and resolving per-provider availability.
 * @param m - Full model entry from {@link getFullModelConfig}.
 * @param modality - Modality the entry belongs to (stamped onto the projection).
 * @param keyMap - Provider→env-var map used to resolve provider availability.
 * @returns The wire-facing catalog entry.
 */
function projectModelEntry(
  m: FullModelEntry,
  modality: Modality,
  keyMap: ReadonlyMap<string, string>,
): ModelEntry {
  const providers = (m.providers ?? []).map((p) => ({
    name: p.name,
    model_id: p.model_id,
    priority: p.priority ?? 99,
    available: isProviderAvailable(p.name, keyMap),
  }));

  return {
    name: m.name,
    display_name: m.display_name ?? m.name,
    modality,
    mode: m.mode as string | string[],
    description: m.description ?? "",
    guide: m.guide ?? "",
    tier: (m.tier as ModelTier) ?? "optional",
    cost_per_call: m.cost_per_call ?? 0,
    generation_time: m.generation_time ?? 60,
    // Same blind cast as the yaml guidelines promise (every param has
    // description + default); FullParamSpec keeps them optional because it
    // mirrors what is literally on disk.
    params: (m.params ?? {}) as unknown as Record<string, ParamDescriptor>,
    providers,
    // #1675 cross-modality execute gate: precompute per-mode source needs so
    // the frontend reads them off the wire (the rule stays backend-side).
    sourcesByMode: computeSourcesByMode(modality, m.mode as string | string[]),
    icon: m.icon,
  };
}

let _cache: ModelCatalog | null = null;

/**
 * Load the full model catalog from YAML configs.
 *
 * Results are cached after first load. Models are filtered to only include
 * those with at least one available provider (has API key configured),
 * unless no keys are configured at all (returns everything for development).
 * @returns Complete model catalog grouped by modality
 */
export function getModelCatalog(): ModelCatalog {
  if (_cache) return _cache;

  const keyMap = loadProviderKeyMap();
  const catalog: Record<Modality, ModelEntry[]> = {
    image: [],
    video: [],
    audio: [],
    tts: [],
    three_d: [],
    understand: [],
  };

  for (const modality of MODALITIES) {
    // Per CLAUDE.md "core/shared/domain write no logs" mandate, parse
    // errors throw inside getFullModelConfig so the application boot path
    // catches + logs with the right context (catalog load is at server
    // startup — a malformed YAML should fail-fast, not silently drop the
    // affected modality).
    catalog[modality] = getFullModelConfig(modality).models.map((m) =>
      projectModelEntry(m, modality, keyMap),
    );
  }

  // Check if any keys are configured at all
  const anyKeyConfigured = [...keyMap.values()].some((envVar) => {
    const value = (env as Record<string, unknown>)[envVar];
    return typeof value === "string" && value.length > 0;
  });

  // If keys are configured, filter to only available models
  if (anyKeyConfigured) {
    for (const modality of MODALITIES) {
      catalog[modality] = catalog[modality].filter(
        (m) => m.providers.some((p) => p.available),
      );
    }
  }

  const total = MODALITIES.reduce((sum, m) => sum + catalog[m].length, 0);

  _cache = { ...catalog, total };
  return _cache;
}

/**
 * List available models for a single modality, formatted for skill
 * prompt injection.
 *
 * Returns a lighter shape than `ModelEntry` — just the fields that
 * skill prompts need: name, mode, guide, description, params, and
 * voices (for TTS models).
 * @param modality - e.g. "image", "video", "audio", "tts", "three_d", "understand"
 */
export interface SkillModelInfo {
  name: string;
  mode: string | string[];
  guide?: string;
  description?: string;
  languages?: string[];
  params?: Record<string, { type?: string; values?: unknown[]; default?: unknown; description?: string }>;
  voices?: Array<{ id: string; gender?: string; description?: string }>;
}

/**
 * List available models for one modality in the lighter
 * {@link SkillModelInfo} shape used for skill prompt injection.
 * @param modality - Modality name (e.g. "image", "video", "audio", "tts", "three_d", "understand"); unknown values yield an empty list.
 * @returns The modality's models projected to the skill-prompt shape.
 */
export function listAvailableModels(modality: string): SkillModelInfo[] {
  const catalog = getModelCatalog();
  const entries = catalog[modality as Modality] ?? [];
  return entries.map((m) => ({
    name: m.name,
    mode: m.mode,
    guide: m.guide || undefined,
    description: m.description || undefined,
    params: Object.keys(m.params).length > 0
      ? Object.fromEntries(
          Object.entries(m.params).map(([k, v]) => [k, {
            type: v.type,
            values: v.values as unknown[] | undefined,
            default: v.default,
            description: v.description,
          }]),
        )
      : undefined,
  }));
}

/**
 * Floor a task's pre-check estimate never goes below. Also the flat
 * requirement for tasks whose model (and therefore `cost_per_call`) is
 * unknown at enqueue time — mini-tools, skill-auto flows. One shared
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
 * Looks the model up across every modality and returns its
 * `cost_per_call`; unknown / unspecified models fall back to
 * {@link MIN_TASK_CREDIT_COST} (the pre-check's job is refusing broke
 * requests, not exact pricing).
 * @param model - Model name from the request body, if any.
 * @returns The credits the caller must at least hold to enqueue.
 */
export function estimateTaskCredits(model?: string): number {
  if (model) {
    const catalog = getModelCatalog();
    for (const modality of MODALITIES) {
      const entry = catalog[modality].find((m) => m.name === model);
      if (entry && entry.cost_per_call > 0) return entry.cost_per_call;
    }
  }
  return MIN_TASK_CREDIT_COST;
}

/**
 * #1675 server execute gate (cross-modality): whether a model whose modes all
 * require a source input was submitted without the required source(s) in
 * `params`. The /canvas/tasks route runs this BEFORE enqueue — billing happens
 * post-worker (markCompletedAndBill), so rejecting here means no task row, no
 * job, no bill for an input the model would reject (e.g. Nano Banana Edit
 * requires an image; a video-edit requires a video). Defence in depth behind the
 * panel's frontend gate.
 *
 * The rule is the SAME `sourcesByMode` the frontend reads off the wire — this
 * looks the model up and applies {@link violatesSourceRequirement} to the
 * submitted params. A model that can run source-less (any t2i-like mode / a
 * hybrid), an unknown model, or an absent model all pass.
 * @param model - The task's model name from the request body, if any.
 * @param params - The task params (the wire `params.images` / `video_url` / … carry sources).
 * @returns True when a required source type is missing → reject before billing.
 */
export function violatesSourceRequirementForModel(
  model: string | undefined,
  params: Record<string, unknown>,
): boolean {
  if (!model) return false;
  const catalog = getModelCatalog();
  for (const modality of MODALITIES) {
    const entry = catalog[modality].find((m) => m.name === model);
    if (entry) return violatesSourceRequirement(entry.sourcesByMode, params);
  }
  return false; // unknown model — existence is not this gate's job
}

/**
 * #1735 server reference-count gate: whether the submitted params carry more
 * items in a capped list param than the model's `max_items` allows. The
 * /canvas/tasks route runs this BEFORE enqueue so an over-picked submission is
 * rejected (with a message naming the limit) rather than silently truncated by
 * the worker (providers/shared.ts). Sits at the same gate as
 * {@link violatesSourceRequirementForModel}, reading the model's per-param
 * `max_items` off the wire {@link ParamDescriptor}. An unknown / absent model
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

/** Reset cached catalog and full-config caches (for testing). */
export function resetModelCatalog(): void {
  _cache = null;
  _fullConfigCache.clear();
}
