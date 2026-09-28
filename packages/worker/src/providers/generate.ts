// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One generation for any catalog model (#2156). Every image, video, audio
 * and speech model runs on WaveSpeed, and each declares in its yaml the
 * upstream name of every field it sends — so the request is built from that
 * declaration, not from per-vendor code. The two models whose request needs
 * more than a field mapping have a family in `families/`.
 *
 * Public API (consumed by worker/handlers):
 *
 * - {@link validateModelParams} -- validate and fill defaults
 * - {@link generateAsync} -- resolve -> body -> prediction -> billed result
 */

import { getFullModelConfig } from "@breatic/domain";
import type { FullModelEntry } from "@breatic/domain";

import {
  resolveModel,
  acquireSemaphore,
  validateParams,
  type ModelFamily,
  type ResumeContext,
} from "@worker/providers/shared.js";
import { upstreamBody } from "@worker/providers/upstream-body.js";
import { runPrediction } from "@worker/providers/wavespeed.js";
import { queryBilling } from "@worker/providers/http.js";
import midjourney from "@worker/providers/families/midjourney.js";
import nanoBanana from "@worker/providers/families/nano-banana.js";

/** The catalog modalities this path serves (3D keeps its own). */
export type CatalogModality = "image" | "video" | "audio" | "tts";

/** What one generation produced. */
export interface GenerationResult {
  url: string;
  model: string;
  /** What WaveSpeed billed, in USD; 0 when there was no prediction to bill. */
  cost: number;
}

/** Model name -> family, for the models that have one. */
export const FAMILIES = new Map<string, ModelFamily>(
  [midjourney, nanoBanana].flatMap((family) => [...family.MODELS].map((name) => [name, family] as const)),
);

/**
 * The model's catalog entry.
 * @param modality - The model's modality.
 * @param modelName - The model name.
 * @returns The entry.
 * @throws {Error} when the catalog has no such model.
 */
export function entryOf(modality: CatalogModality, modelName: string): FullModelEntry {
  const entry = getFullModelConfig(modality).models.find((m) => m.name === modelName);
  if (!entry) throw new Error(`Model '${modelName}' not found`);
  return entry;
}

/**
 * Run one generation: build the body from the model's declaration, run the
 * prediction under the provider's concurrency cap, and bill what it cost.
 * @param modality - The model's modality.
 * @param prompt - The reader's prompt.
 * @param modelName - Model name (required).
 * @param params - Validated params (see {@link validateModelParams}).
 * @param resume - Worker resume context for at-most-once submit (#1628).
 * @returns The first output's url, the model and the billed cost.
 * @throws {Error} when the model cannot be resolved, the prediction fails, or
 *   it answers no output.
 */
export async function generateAsync(
  modality: CatalogModality,
  prompt: string,
  modelName: string | undefined,
  params: Readonly<Record<string, unknown>> = {},
  resume?: ResumeContext,
): Promise<GenerationResult> {
  const resolved = resolveModel(modality, modelName);
  const entry = entryOf(modality, resolved.modelName);
  const family = FAMILIES.get(resolved.modelName);
  const prepared = family ? await family.prepare(prompt, params) : { prompt, fields: {} };
  const body = {
    ...upstreamBody(entry, params, prepared.prompt, family?.CONSUMES),
    ...prepared.fields,
  };

  const release = await acquireSemaphore(resolved.providerName, resolved.maxConcurrency);
  const run = await runPrediction(resolved, resolved.modelId, body, resume).finally(release);

  const url = run.outputs[0];
  if (typeof url !== "string" || url === "") throw new Error("No output URL after WaveSpeed polling");
  const cost = run.taskId ? await queryBilling(resolved, run.taskId) : 0;
  return { url, model: resolved.modelName, cost };
}

/**
 * Validate and fill defaults for a catalog model's params.
 * @param modality - The model's modality.
 * @param modelName - Model name (required).
 * @param params - User-provided parameters to validate.
 * @returns Tuple of [resolvedModelName, cleanedParams].
 * @throws {Error} when the model is not in the catalog.
 */
export function validateModelParams(
  modality: CatalogModality,
  modelName: string | undefined,
  params?: Record<string, unknown>,
): [string, Record<string, unknown>] {
  return validateParams(modality, modelName, params);
}
