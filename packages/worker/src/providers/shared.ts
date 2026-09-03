// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Shared AIGC provider utilities.
 *
 * Provides parameter validation, model resolution, and semaphore
 * management — shared across all 6 AIGC providers. Model config comes
 * from domain's getFullModelConfig (#1672): domain is the single
 * config/models YAML reader; this module only turns that config into
 * transport-ready connections.
 */

import { logger } from "@breatic/core";
import { getFullModelConfig, resolveActiveProvider } from "@breatic/domain";
import type { FullModelEntry } from "@breatic/domain";

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
  mode?: string | string[];
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

/**
 * Resume context threaded from the Worker into async (submit + poll)
 * transports (#1628). Makes the vendor submit at-most-once across BullMQ
 * retries: the transport persists the vendor task id right after submit,
 * and a retried job resumes by polling the stored id instead of
 * re-submitting (which would create a duplicate, billed vendor task).
 * Sync transports ignore it.
 */
export interface ResumeContext {
  /** Vendor task id persisted by a previous attempt, or null on first run. */
  storedTaskId: string | null;
  /** Persist the vendor task id right after submit (pre-poll). */
  persistTaskId: (id: string) => Promise<void>;
  /**
   * Deterministic client-side task id (derived from our task UUID) for
   * vendors with idempotent submit (Kling `external_task_id`): a retried
   * identical submit is rejected as a duplicate instead of re-generating.
   */
  externalTaskId: string;
}

/** Transport interface — one per API provider adapter. */
export interface Transport {
  generate(
    prompt: string,
    resolved: ResolvedModel,
    params: Record<string, unknown>,
    resume?: ResumeContext,
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

// ── Parameter Validation (Lenient) ───────────────────────────────────

/**
 * Find model config by name.
 * @param config - Loaded provider config to search
 * @param config.models - The list of model configs to match against
 * @param modelName - Model name to look up; required
 * @returns A `[resolvedName, modelConfig]` tuple for the matched model
 * @throws {Error} when `modelName` is missing or no model matches
 */
function findModelConfig(config: { models: FullModelEntry[] }, modelName: string | undefined): [string, FullModelEntry] {
  if (!modelName) throw new Error("model_name is required");
  const model = config.models.find((m) => m.name === modelName);
  if (!model) throw new Error(`Model '${modelName}' not found`);
  return [model.name, model];
}

/**
 * Validate params leniently — drop unknown, fallback invalid, fill defaults.
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
  const config = getFullModelConfig(modality);
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

/**
 * Resolve model name to a concrete provider endpoint.
 *
 * Which provider serves the model is decided by `resolveActiveProvider` in
 * domain — the voice catalog endpoint asks the same question and has to get
 * the same answer, since it lists voices in the value domain of whichever
 * upstream the generation will go to. What stays here is the transport DTO
 * this package needs on top of that answer.
 * @param modality - Provider modality
 * @param modelName - Model name
 * @returns ResolvedModel with connection details
 * @throws {Error} if no provider has an active API key
 */
export function resolveModel(modality: string, modelName: string | undefined): ResolvedModel {
  const active = resolveActiveProvider(modality, modelName);

  return {
    modelName: active.modelName,
    providerName: active.providerName,
    modelId: active.modelId,
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    timeout: active.timeout,
    costPerCall: active.modelConfig.cost_per_call ?? 0,
    maxConcurrency: active.maxConcurrency,
    tokenPrice: active.providerEntry.token_price,
    creditPrice: active.providerEntry.credit_price,
    extraParams: active.providerEntry.extra_params,
    litellmModel: active.providerEntry.litellm_model,
    mode: active.modelConfig.mode,
  };
}

// ── Semaphore ────────────────────────────────────────────────────────

const _semaphores = new Map<string, { count: number; queue: Array<() => void> }>();

/**
 * Acquire a per-provider semaphore slot.
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
