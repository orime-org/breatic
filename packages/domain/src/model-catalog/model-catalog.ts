/**
 * Model catalog — loads all AIGC model configs from YAML and filters by available API keys.
 *
 * Reads config/models/{modality}/*.yaml at startup, resolves provider availability
 * from environment variables, and serves a cached, filtered catalog for the API.
 * @module
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, extname } from "node:path";
import { parse } from "yaml";
import { env, MONOREPO_ROOT } from "@breatic/core";

/** Root directory for model YAML configs. */
const MODELS_DIR = resolve(MONOREPO_ROOT, "config/models");

/** Supported modalities (subdirectory names). */
const MODALITIES = ["image", "video", "audio", "tts", "three_d", "understand"] as const;
export type Modality = (typeof MODALITIES)[number];

/** Model tier for frontend display filtering. */
export type ModelTier = "recommended" | "optional" | "internal";

/** Single parameter descriptor (for dynamic frontend form rendering). */
export interface ParamDescriptor {
  description: string;
  values?: readonly (string | number | boolean)[];
  min?: number;
  max?: number;
  type?: string;
  max_items?: number;
  default: unknown;
}

/** Provider entry for a model. */
export interface ModelProvider {
  name: string;
  model_id: string;
  priority: number;
  available: boolean;
}

/** Single model definition (API response shape). */
export interface ModelEntry {
  name: string;
  display_name: string;
  modality: Modality;
  mode: string | string[];
  description: string;
  guide: string;
  tier: ModelTier;
  cost_per_call: number;
  generation_time: number;
  params: Record<string, ParamDescriptor>;
  providers: ModelProvider[];
}

/** Full catalog grouped by modality. */
export interface ModelCatalog {
  image: ModelEntry[];
  video: ModelEntry[];
  audio: ModelEntry[];
  tts: ModelEntry[];
  three_d: ModelEntry[];
  understand: ModelEntry[];
  total: number;
}

/**
 * Map provider name → env var name for API key lookup.
 * Built from providers.yaml in each modality directory.
 * @returns A map from provider name to its `api_key_env` variable name.
 */
function loadProviderKeyMap(): ReadonlyMap<string, string> {
  const keyMap = new Map<string, string>();

  for (const modality of MODALITIES) {
    const providersPath = resolve(MODELS_DIR, modality, "providers.yaml");
    try {
      const raw = readFileSync(providersPath, "utf-8");
      const providers = parse(raw) as Record<string, { api_key_env?: string }>;
      for (const [name, config] of Object.entries(providers)) {
        if (config.api_key_env) {
          keyMap.set(name, config.api_key_env);
        }
      }
    } catch {
      // providers.yaml may not exist for all modalities
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
 * Load all models from a single YAML file.
 * @param filePath - Absolute path to the model YAML file.
 * @param modality - Modality the file belongs to (stamped onto each entry).
 * @param keyMap - Provider→env-var map used to resolve provider availability.
 * @returns The parsed {@link ModelEntry} list, or an empty array if the file has no models.
 */
function loadModelsFromFile(
  filePath: string,
  modality: Modality,
  keyMap: ReadonlyMap<string, string>,
): ModelEntry[] {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parse(raw) as { models?: Array<Record<string, unknown>> };
  if (!parsed?.models) return [];

  return parsed.models.map((m) => {
    const providers = ((m.providers as Array<Record<string, unknown>>) ?? []).map((p) => ({
      name: p.name as string,
      model_id: p.model_id as string,
      priority: (p.priority as number) ?? 99,
      available: isProviderAvailable(p.name as string, keyMap),
    }));

    return {
      name: m.name as string,
      display_name: (m.display_name as string) ?? (m.name as string),
      modality,
      mode: m.mode as string | string[],
      description: (m.description as string) ?? "",
      guide: (m.guide as string) ?? "",
      tier: (m.tier as ModelTier) ?? "optional",
      cost_per_call: (m.cost_per_call as number) ?? 0,
      generation_time: (m.generation_time as number) ?? 60,
      params: (m.params as Record<string, ParamDescriptor>) ?? {},
      providers,
    };
  });
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
    const dir = resolve(MODELS_DIR, modality);
    let files: string[];
    try {
      files = readdirSync(dir).filter(
        (f) => extname(f) === ".yaml" && f !== "providers.yaml",
      );
    } catch {
      continue;
    }

    for (const file of files) {
      // Per CLAUDE.md "core/shared/domain write no logs" mandate, parse
      // errors throw so the application boot path catches + logs
      // with the right context (catalog load is at server startup —
      // a malformed YAML should fail-fast, not silently drop the
      // affected modality).
      const models = loadModelsFromFile(resolve(dir, file), modality, keyMap);
      catalog[modality].push(...models);
    }
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

/** Reset cached catalog (for testing). */
export function resetModelCatalog(): void {
  _cache = null;
}
