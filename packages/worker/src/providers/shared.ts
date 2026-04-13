/**
 * Shared AIGC provider utilities.
 *
 * Provides config loading, parameter validation, model resolution,
 * and semaphore management — shared across all 6 AIGC providers.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse } from "yaml";
import { env, logger } from "@breatic/core";

// ── Types ────────────────────────────────────────────────────────────

/** Resolved model endpoint ready for transport. */
export interface ResolvedModel {
  modelName: string;
  providerName: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  timeout: number;
  costPerCall: number;
  maxConcurrency: number;
  tokenPrice?: number;
  creditPrice?: number;
  extraParams?: Record<string, unknown>;
  litellmModel?: string;
  mode?: string;
}

/** Model family interface — one per model family file. */
export interface ModelFamily {
  MODELS: ReadonlySet<string>;
  buildRequest(
    prompt: string,
    modelName: string,
    params: Record<string, unknown>,
    providerName?: string,
  ): Promise<[string, Record<string, unknown>]>;
}

/** Transport interface — one per API provider adapter. */
export interface Transport {
  generate(
    prompt: string,
    resolved: ResolvedModel,
    params: Record<string, unknown>,
  ): Promise<TransportResult>;
}

/**
 * Transport result — either a URL (async providers) or raw bytes (sync providers).
 *
 * Sync transports (ElevenLabs, MiniMax, Fish) return `buffer` + `contentType`.
 * Async transports (WaveSpeed, Kling, etc.) return `url` (temporary CDN link).
 * The Worker handles all storage logic uniformly via `persistResultUrls`.
 */
export interface TransportResult {
  url?: string;
  text?: string;
  buffer?: Buffer;
  contentType?: string;
  model: string;
  cost: number;
}

/** Raw YAML model config. */
interface ModelConfig {
  name: string;
  display_name?: string;
  mode?: string;
  description?: string;
  guide?: string;
  cost_per_call?: number;
  params?: Record<string, ParamSpec>;
  providers?: Array<{
    name: string;
    model_id: string;
    priority?: number;
    token_price?: number;
    credit_price?: number;
    extra_params?: Record<string, unknown>;
    litellm_model?: string;
  }>;
}

interface ParamSpec {
  default?: unknown;
  values?: unknown[];
  max_items?: number;
}

interface ProviderConfig {
  base_url?: string;
  api_key_env?: string;
  timeout?: number;
  max_concurrency?: number;
}

// ── Config Loading ───────────────────────────────────────────────────

const _configCache = new Map<string, { models: ModelConfig[]; providers: Record<string, ProviderConfig> }>();

/**
 * Load provider config from YAML directory.
 *
 * @param modality - Provider modality (e.g. "image", "video")
 * @returns Merged config with models and providers
 */
export function loadConfig(modality: string): { models: ModelConfig[]; providers: Record<string, ProviderConfig> } {
  if (_configCache.has(modality)) return _configCache.get(modality)!;

  const configDir = resolve(import.meta.dirname, "../../../../config/models", modality);
  if (!existsSync(configDir)) return { models: [], providers: {} };

  const allModels: ModelConfig[] = [];
  for (const file of readdirSync(configDir).sort()) {
    if (!file.endsWith(".yaml") || file === "providers.yaml") continue;
    const raw = readFileSync(join(configDir, file), "utf-8");
    const data = parse(raw) as { models?: ModelConfig[] } | null;
    if (data?.models) allModels.push(...data.models);
  }

  const providersFile = join(configDir, "providers.yaml");
  let providers: Record<string, ProviderConfig> = {};
  if (existsSync(providersFile)) {
    providers = (parse(readFileSync(providersFile, "utf-8")) as Record<string, ProviderConfig>) ?? {};
  }

  const config = { models: allModels, providers };
  _configCache.set(modality, config);
  return config;
}

// ── Parameter Validation (Lenient) ───────────────────────────────────

/** Find model config by name. */
function findModelConfig(config: { models: ModelConfig[] }, modelName: string | undefined): [string, ModelConfig] {
  if (!modelName) throw new Error("model_name is required");
  const model = config.models.find((m) => m.name === modelName);
  if (!model) throw new Error(`Model '${modelName}' not found`);
  return [model.name, model];
}

/**
 * Validate params leniently — drop unknown, fallback invalid, fill defaults.
 *
 * @param modality - Provider modality
 * @param modelName - Model name
 * @param params - User-provided params
 * @returns Tuple of [resolvedModelName, cleanedParams]
 */
export function validateParams(
  modality: string,
  modelName: string | undefined,
  params?: Record<string, unknown>,
): [string, Record<string, unknown>] {
  const config = loadConfig(modality);
  const [name, modelCfg] = findModelConfig(config, modelName);
  const paramSpecs = modelCfg.params ?? {};
  const cleaned: Record<string, unknown> = {};
  const provided = params ? { ...params } : {};

  for (const [key, value] of Object.entries(provided)) {
    if (!(key in paramSpecs)) {
      logger.warn({ model: name, param: key }, "unknown_param_dropped");
      continue;
    }
    const spec = paramSpecs[key]!;
    if (spec.values && !spec.values.includes(value)) {
      logger.warn({ model: name, param: key, value, default: spec.default }, "invalid_param_value_replaced");
      if (spec.default !== undefined) cleaned[key] = spec.default;
      continue;
    }
    if (spec.max_items && Array.isArray(value) && value.length > spec.max_items) {
      logger.warn({ model: name, param: key, count: value.length, maxItems: spec.max_items }, "list_param_truncated");
      cleaned[key] = value.slice(0, spec.max_items);
      continue;
    }
    cleaned[key] = value;
  }

  for (const [key, spec] of Object.entries(paramSpecs)) {
    if (!(key in cleaned) && spec.default !== undefined) {
      cleaned[key] = spec.default;
    }
  }

  return [name, cleaned];
}

// ── Model Resolution ─────────────────────────────────────────────────

/** Get API key from env by env var name (e.g. "WAVESPEED_API_KEY"). */
function getApiKey(envVarName: string): string {
  if (!envVarName) return "";
  const val = (env as Record<string, unknown>)[envVarName];
  return typeof val === "string" ? val : "";
}

/**
 * Resolve model name to a concrete provider endpoint.
 *
 * @param modality - Provider modality
 * @param modelName - Model name
 * @returns ResolvedModel with connection details
 * @throws Error if no provider has an active API key
 */
export function resolveModel(modality: string, modelName: string | undefined): ResolvedModel {
  const config = loadConfig(modality);
  const [name, modelCfg] = findModelConfig(config, modelName);

  const sorted = [...(modelCfg.providers ?? [])].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));

  for (const p of sorted) {
    const pcfg = config.providers[p.name] ?? {};
    const apiKey = getApiKey(pcfg.api_key_env ?? "");
    if (apiKey) {
      return {
        modelName: name,
        providerName: p.name,
        modelId: p.model_id,
        baseUrl: pcfg.base_url ?? "",
        apiKey,
        timeout: pcfg.timeout ?? 120,
        costPerCall: modelCfg.cost_per_call ?? 0,
        maxConcurrency: pcfg.max_concurrency ?? 50,
        tokenPrice: p.token_price,
        creditPrice: p.credit_price,
        extraParams: p.extra_params,
        litellmModel: p.litellm_model,
        mode: modelCfg.mode,
      };
    }
  }

  throw new Error(`No provider with active API key for model '${name}'. Check your .env file.`);
}

/**
 * List models that have at least one provider with an active API key.
 *
 * @param modality - Provider modality
 * @returns Model info dicts for skill injection
 */
export function listAvailableModels(modality: string): Array<{
  name: string;
  displayName: string;
  mode: string;
  description: string;
  guide: string;
  params: Record<string, unknown>;
}> {
  const config = loadConfig(modality);
  const result: ReturnType<typeof listAvailableModels> = [];

  for (const model of config.models) {
    const hasKey = (model.providers ?? []).some((p) => {
      const pcfg = config.providers[p.name] ?? {};
      return !!getApiKey(pcfg.api_key_env ?? "");
    });
    if (!hasKey) continue;

    result.push({
      name: model.name,
      displayName: model.display_name ?? model.name,
      mode: model.mode ?? "t2i",
      description: model.description ?? "",
      guide: model.guide ?? "",
      params: model.params ?? {},
    });
  }

  return result;
}

// ── Semaphore ────────────────────────────────────────────────────────

const _semaphores = new Map<string, { count: number; queue: Array<() => void> }>();

/**
 * Acquire a per-provider semaphore slot.
 *
 * @param providerName - Provider key
 * @param maxConcurrency - Max concurrent requests
 * @returns A release function to call when done
 */
export async function acquireSemaphore(providerName: string, maxConcurrency: number): Promise<() => void> {
  if (!_semaphores.has(providerName)) {
    _semaphores.set(providerName, { count: 0, queue: [] });
  }
  const sem = _semaphores.get(providerName)!;

  if (sem.count < maxConcurrency) {
    sem.count++;
    return () => {
      sem.count--;
      const next = sem.queue.shift();
      if (next) { sem.count++; next(); }
    };
  }

  return new Promise<() => void>((resolve) => {
    sem.queue.push(() => {
      resolve(() => {
        sem.count--;
        const next = sem.queue.shift();
        if (next) { sem.count++; next(); }
      });
    });
  });
}
