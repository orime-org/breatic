// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Shared AIGC provider utilities.
 *
 * Provides parameter validation, model resolution, and semaphore
 * management — shared by the catalog generation path and 3D. Model config comes
 * from domain's getFullModelConfig (#1672): domain is the single
 * config/models YAML reader; this module only turns that config into
 * transport-ready connections.
 */

import { logger } from "@breatic/core";
import { itemCap } from "@breatic/shared";
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
  maxConcurrency: number;
  mode?: string | string[];
}

/**
 * A catalog model whose request needs more than its declaration maps: the
 * params it names in `CONSUMES` are left out of the upstream body, and
 * `prepare` answers the prompt to send plus any upstream fields it writes
 * itself (#2156).
 */
export interface ModelFamily {
  MODELS: ReadonlySet<string>;
  CONSUMES: ReadonlySet<string>;
  prepare(
    prompt: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<{ prompt: string; fields: Record<string, unknown> }>;
}

/** A 3D model family: rewrites the prompt and params before its transport. */
export interface ThreeDFamily {
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
 * transports (#1628). Makes the vendor submit at-most-once across pickups
 * and retries: the transport persists the vendor task id right after submit,
 * and every later pickup asks about the stored id instead of re-submitting
 * (which would create a duplicate, billed vendor task).
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
  /**
   * Whether this pickup starts a retry and this run has not stored an id yet:
   * a submit now may be the upstream's second (#1628 monitoring).
   */
  retryStarting: boolean;
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
    // Read through the one function the panel's picker gate and the server's
    // pre-enqueue gate read. Judging a different number here is how a
    // submission the server let through gets quietly cut.
    const cap = itemCap(spec);
    if (cap !== undefined && Array.isArray(value) && value.length > cap) {
      logger.warn({ model: name, param: key, count: value.length, maxItems: cap }, "list_param_truncated");
      cleaned[key] = value.slice(0, cap);
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
    maxConcurrency: active.maxConcurrency,
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
