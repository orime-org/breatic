// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One generation for any catalog model (#2156). Every image, video, audio
 * and speech model runs on WaveSpeed, and each declares in its yaml the
 * upstream name of every field it sends — so the request is built from that
 * declaration, not from per-vendor code. The two models whose request needs
 * more than a field mapping have a family in `families/`.
 *
 * A run itself goes through `run-steps.ts`; this module holds what it reads
 * about the model: the catalog entry, the family, and param validation.
 */

import { getFullModelConfig } from "@breatic/domain";
import type { FullModelEntry } from "@breatic/domain";

import { validateParams, type ModelFamily } from "@worker/providers/shared.js";
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
