// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Kling model family -- KwaiVGI video generation (O3, O1, V3 Motion).
 *
 * Handles all Kling video models across generations and modes (t2v, i2v,
 * first_last, ref, edit, motion).  {@link buildRequest} branches on
 * `providerName` to convert our param names into the ones that provider
 * takes -- see {@link applyFieldNames} for why a mapping is stated even when
 * the two names agree.
 */

import { applyFieldNames } from "@worker/providers/field-mapping.js";
import type { FieldNames } from "@worker/providers/field-mapping.js";
import type { ModelFamily } from "@worker/providers/shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  // O3
  "kling-o3-pro", "kling-o3-pro-i2v",
  "kling-o3-pro-ref", "kling-o3-pro-edit",
  // V3 Motion
  "kling-v3-pro-motion",
]);

/**
 * Names this family has always used, for the models that have not been mapped
 * one by one yet (#1908). Every one of these is inherited, not verified: the
 * KlingAI column is what sent `kling-o3-pro-i2v`'s first frame under a name
 * the vendor does not accept, until #1904 gave that model its own entry below.
 */
const FAMILY_FIELDS: Readonly<Record<string, FieldNames>> = {
  klingai: {
    image: "image_url",
    end_image: "tail_image_url",
    element_list: "elements",
    video: "video_url",
  },
  wavespeed: {
    generate_audio: "sound",
  },
};

/**
 * What one model calls its fields on one provider. Merged over
 * {@link FAMILY_FIELDS}, so a model states only what is its own.
 *
 * `kling-o3-pro-i2v` (#1904): KlingAI's `/v1/videos/image2video` takes `image`
 * and `image_tail`; WaveSpeed's `kwaivgi/kling-video-o3-pro/image-to-video`
 * takes `image` and `end_image`. The first frame agrees on both and is written
 * out on both.
 */
const MODEL_FIELDS: Readonly<Record<string, Readonly<Record<string, FieldNames>>>> = {
  "kling-o3-pro-i2v": {
    klingai: { image: "image", end_image: "image_tail" },
    wavespeed: { image: "image", end_image: "end_image" },
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
 * Build WaveSpeed API params for Kling models.
 * @param prompt - User's video description, returned unchanged
 * @param modelName - Resolved model name, which picks the name table
 * @param params - Validated params to map into WaveSpeed naming
 * @returns Tuple of [prompt, apiParams] in WaveSpeed format
 */
function buildWavespeed(
  prompt: string,
  modelName: string,
  params: Record<string, unknown>,
): [string, Record<string, unknown>] {
  return [prompt, applyFieldNames(params, fieldNamesFor(modelName, "wavespeed"))];
}

/**
 * Build Kling official API params.
 *
 * Beyond the name table, the official API wants the duration as a string.
 * @param prompt - User's video description, returned unchanged
 * @param modelName - Resolved model name, which picks the name table
 * @param params - Validated params to map into Kling official naming
 * @returns Tuple of [prompt, apiParams] in Kling official format
 */
function buildKlingai(
  prompt: string,
  modelName: string,
  params: Record<string, unknown>,
): [string, Record<string, unknown>] {
  const api = applyFieldNames(params, fieldNamesFor(modelName, "klingai"));
  if (api.duration != null) {
    api.duration = String(api.duration);
  }
  return [prompt, api];
}

/**
 * Convert user-facing params to provider-specific API params.
 * @param prompt - User's video description
 * @param modelName - Resolved model name (e.g. "kling-o3-pro")
 * @param params - Validated params from YAML defaults + user input
 * @param providerName - Target provider ("wavespeed" or "klingai")
 * @returns Tuple of [prompt, apiParams]
 */
export async function buildRequest(
  prompt: string,
  modelName: string,
  params: Record<string, unknown>,
  providerName?: string,
): Promise<[string, Record<string, unknown>]> {
  // Remove null/undefined values and default seed
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v != null) cleaned[k] = v;
  }
  if (cleaned.seed === -1) delete cleaned.seed;

  if (providerName === "klingai") {
    return buildKlingai(prompt, modelName, cleaned);
  }
  return buildWavespeed(prompt, modelName, cleaned);
}

export default { MODELS, buildRequest } satisfies ModelFamily;
