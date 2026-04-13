/**
 * Model catalog — loads all AIGC model configs from YAML and filters by available API keys.
 *
 * Reads config/models/{modality}/*.yaml at startup, resolves provider availability
 * from environment variables, and serves a cached, filtered catalog for the API.
 *
 * @module
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, extname } from "node:path";
import { parse } from "yaml";
import { env } from "./env.js";
import { logger } from "../logger.js";

/** Root directory for model YAML configs. */
const MODELS_DIR = resolve(import.meta.dirname, "../../../../config/models");

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
 */
function isProviderAvailable(providerName: string, keyMap: ReadonlyMap<string, string>): boolean {
  const envVar = keyMap.get(providerName);
  if (!envVar) return false;
  const value = (env as Record<string, unknown>)[envVar];
  return typeof value === "string" && value.length > 0;
}

/**
 * Load all models from a single YAML file.
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
 *
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
      try {
        const models = loadModelsFromFile(resolve(dir, file), modality, keyMap);
        catalog[modality].push(...models);
      } catch (err) {
        logger.warn({ file, modality, err }, "Failed to parse model YAML");
      }
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

  logger.info(
    {
      image: catalog.image.length,
      video: catalog.video.length,
      audio: catalog.audio.length,
      tts: catalog.tts.length,
      three_d: catalog.three_d.length,
      understand: catalog.understand.length,
      total,
      filtered: anyKeyConfigured,
    },
    "Model catalog loaded",
  );

  _cache = { ...catalog, total };
  return _cache;
}

/** Reset cached catalog (for testing). */
export function resetModelCatalog(): void {
  _cache = null;
}
