// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Seedance model family -- ByteDance video generation (2.0, 1.5, 1.0 Lite).
 *
 * Handles all Seedance video models across generations and modes (t2v, i2v,
 * first_last, ref, extend).  {@link buildRequest} branches on `providerName`
 * to convert our param names into the ones that provider takes -- see
 * {@link applyFieldNames} for why a mapping is stated even when the two names
 * agree.
 */

import { applyFieldNames } from "@worker/providers/field-mapping.js";
import type { FieldNames } from "@worker/providers/field-mapping.js";
import type { ModelFamily } from "@worker/providers/shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "seedance-2.0",
  "seedance-1.5-pro-i2v",
]);

/**
 * Names this family has always used, for the models that have not been mapped
 * one by one yet (#1908).
 */
const FAMILY_FIELDS: Readonly<Record<string, FieldNames>> = {
  wavespeed: {
    end_image: "last_image",
  },
  byteplus: {
    image: "image_url",
    end_image: "end_image_url",
    video: "video_url",
  },
};

/**
 * What one model calls its fields on one provider. Merged over
 * {@link FAMILY_FIELDS}, so a model states only what is its own.
 *
 * `seedance-1.5-pro-i2v` (#1904): WaveSpeed's
 * `bytedance/seedance-v1.5-pro/image-to-video` takes `image` and `last_image`;
 * BytePlus takes `image_url` and `end_image_url`. The WaveSpeed first frame
 * happens to keep our name and is written out all the same.
 */
const MODEL_FIELDS: Readonly<Record<string, Readonly<Record<string, FieldNames>>>> = {
  "seedance-1.5-pro-i2v": {
    wavespeed: { image: "image", end_image: "last_image" },
    byteplus: { image: "image_url", end_image: "end_image_url" },
  },
};

/**
 * The field names one model uses on one provider: what the family has always
 * done, overridden by whatever the model states for itself.
 * @param modelName - Resolved model name.
 * @param providerName - Provider the request is going to.
 * @returns The merged name table.
 */
function fieldNamesFor(modelName: string, providerName: string): FieldNames {
  return {
    ...(FAMILY_FIELDS[providerName] ?? {}),
    ...(MODEL_FIELDS[modelName]?.[providerName] ?? {}),
  };
}

/**
 * Convert user-facing params to provider-specific API params.
 * @param prompt - User's video description
 * @param modelName - Resolved model name (e.g. "seedance-1.5-pro-i2v")
 * @param params - Validated params from YAML defaults + user input
 * @param providerName - Target provider ("wavespeed" or "byteplus")
 * @returns Tuple of [prompt, apiParams]
 */
export async function buildRequest(
  prompt: string,
  modelName: string,
  params: Record<string, unknown>,
  providerName?: string,
): Promise<[string, Record<string, unknown>]> {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v != null) cleaned[k] = v;
  }
  if (cleaned.seed === -1) delete cleaned.seed;

  const provider = providerName === "byteplus" ? "byteplus" : "wavespeed";
  return [prompt, applyFieldNames(cleaned, fieldNamesFor(modelName, provider))];
}

export default { MODELS, buildRequest } satisfies ModelFamily;
