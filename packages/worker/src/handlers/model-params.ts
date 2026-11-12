// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A model run's params checked against its catalog entry, leniently: an undeclared key is dropped, a value outside
 * the declared ones falls back to the default, a list past its cap is cut, defaults are filled, and the params are
 * resolved the way every reader resolves them (inner#1691).
 */

import { logger } from "@breatic/core";
import { checkParamCombination, itemCap, resolveParams, type ResolvableModel } from "@breatic/shared";
import { getFullModelConfig, type FullModelEntry } from "@breatic/domain";

/** The catalog modalities a model run serves. */
export type CatalogModality = "image" | "video" | "audio" | "tts" | "three_d";

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
 * Drop unknown params, fall back on invalid values, cut lists past their cap and fill defaults.
 * @param model - The model's catalog entry.
 * @param params - User-provided params.
 * @returns The cleaned params.
 */
function cleanParams(model: FullModelEntry, params: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const specs = model.params ?? {};
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    const spec = specs[key];
    if (spec === undefined) {
      logger.warn({ model: model.name, param: key }, "unknown_param_dropped");
      continue;
    }
    if (spec.values && !spec.values.includes(value)) {
      logger.warn({ model: model.name, param: key, value, default: spec.default }, "invalid_param_value_replaced");
      if (spec.default !== undefined) cleaned[key] = spec.default;
      continue;
    }
    // Read through the one function the panel's picker gate and the server's pre-enqueue gate read. Judging a
    // different number here is how a submission the server let through gets quietly cut.
    const cap = itemCap(spec);
    if (cap !== undefined && Array.isArray(value) && value.length > cap) {
      logger.warn({ model: model.name, param: key, count: value.length, maxItems: cap }, "list_param_truncated");
      cleaned[key] = value.slice(0, cap);
      continue;
    }
    cleaned[key] = value;
  }
  for (const [key, spec] of Object.entries(specs)) {
    if (!(key in cleaned) && spec.default !== undefined) cleaned[key] = spec.default;
  }
  return cleaned;
}

/**
 * Validate a catalog model's params and resolve them: defaults filled, forced values applied, what a condition
 * switches off dropped.
 * @param modality - The model's modality.
 * @param modelName - The model name.
 * @param params - User-provided params.
 * @returns The model name and the resolved params.
 * @throws {Error} when the model is not in the catalog, or a text param is longer than its cap once cleaned.
 */
export function validateModelParams(
  modality: CatalogModality,
  modelName: string,
  params: Readonly<Record<string, unknown>>,
): [string, Record<string, unknown>] {
  const entry = entryOf(modality, modelName);
  const cleaned = cleanParams(entry, params);
  const model = entry as unknown as ResolvableModel;
  const tooLong = checkParamCombination(model, cleaned).find((v) => v.rule === "max_length");
  if (tooLong?.rule === "max_length") {
    throw new Error(`${tooLong.param} is ${tooLong.length} characters once cleaned; ${entry.name} takes at most ${tooLong.max}`);
  }
  return [entry.name, resolveParams(model, cleaned)];
}
