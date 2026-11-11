// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * One generation for any catalog model (#2156). Every image, video, audio
 * and speech model runs on WaveSpeed, and each declares in its yaml the
 * upstream name of every field it sends — so the request is built from that
 * declaration, not from per-vendor code. The three models whose request needs
 * more than a field mapping have a family in `families/`.
 *
 * A run itself goes through `run-steps.ts`; this module holds what it reads
 * about the model: the catalog entry, the family, and param validation.
 */

import { checkParamCombination, extractPromptText, resolveParams, type ResolvableModel } from "@breatic/shared";
import { getFullModelConfig } from "@breatic/domain";
import type { FullModelEntry } from "@breatic/domain";

import { validateParams, type ModelFamily } from "@worker/providers/shared.js";
import minimaxSpeech from "@worker/providers/families/minimax-speech.js";
import nanoBanana from "@worker/providers/families/nano-banana.js";
import nanoBananaRelight from "@worker/providers/families/nano-banana-relight.js";

/** The catalog modalities this path serves. */
export type CatalogModality = "image" | "video" | "audio" | "tts" | "three_d";

/** What one generation produced. */
export interface GenerationResult {
  /** What the run produced, in upstream order, up to the count asked for. */
  outputs: { url: string }[];
  model: string;
  /** What WaveSpeed billed, in USD; 0 when there was no prediction to bill. */
  cost: number;
}

/** Model name -> family, for the models that have one. */
export const FAMILIES = new Map<string, ModelFamily>(
  [minimaxSpeech, nanoBanana, nanoBananaRelight].flatMap((family) => [...family.MODELS].map((name) => [name, family] as const)),
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
 * Validate a catalog model's params and resolve them the way every reader
 * does (inner#1691): defaults filled, forced values applied, what a
 * condition switches off dropped.
 * @param modality - The model's modality.
 * @param modelName - Model name (required).
 * @param params - User-provided parameters to validate.
 * @returns Tuple of [resolvedModelName, resolvedParams].
 * @throws {Error} when the model is not in the catalog, or a text param is
 *   longer than its cap once cleaned.
 */
export function validateModelParams(
  modality: CatalogModality,
  modelName: string | undefined,
  params?: Record<string, unknown>,
): [string, Record<string, unknown>] {
  const [name, validated] = validateParams(modality, modelName, params);
  const entry = entryOf(modality, name);
  // Every text setting is something the user typed, cleaned as a prompt is
  // before its length is judged, so what is judged is what is sent; so is
  // each text field of a list's entries (a speaker's name, which the script
  // names in its cleaned form).
  const cleaned = Object.fromEntries(
    Object.entries(validated).map(([key, value]) => {
      const spec = entry.params?.[key];
      if (spec?.type === "text" && typeof value === "string") return [key, extractPromptText(value)];
      if (spec?.type !== "items" || !Array.isArray(value)) return [key, value];
      const fields = spec.fields ?? {};
      return [key, value.map((item: unknown) =>
        typeof item === "object" && item !== null && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([field, held]) =>
            [field, fields[field]?.type === "text" && typeof held === "string" ? extractPromptText(held) : held]))
          : item,
      )];
    }),
  );
  const model = entry as unknown as ResolvableModel;
  const found = checkParamCombination(model, cleaned);
  const tooLong = found.find((v) => v.rule === "max_length");
  if (tooLong?.rule === "max_length") {
    throw new Error(`${tooLong.param} is ${tooLong.length} characters once cleaned; ${name} takes at most ${tooLong.max}`);
  }
  // The server refuses it before queueing; a job that got past is never sent.
  const tooShort = found.find((v) => v.rule === "min_length");
  if (tooShort?.rule === "min_length") {
    throw new Error(`${tooShort.param} is ${tooShort.length} characters once cleaned; ${name} takes at least ${tooShort.min}`);
  }
  return [name, resolveParams(model, cleaned)];
}
