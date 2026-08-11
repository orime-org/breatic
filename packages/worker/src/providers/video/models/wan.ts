// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Wan model family -- Alibaba video generation (2.2 Animate only).
 *
 * Handles the Wan 2.2 Animate model: a character image plus a driving video,
 * whose body movement and facial expression are transferred onto the
 * character. Only the WaveSpeed transport is used.
 */

import { applyFieldNames } from "@worker/providers/field-mapping.js";
import type { FieldNames } from "@worker/providers/field-mapping.js";
import type { ModelFamily } from "@worker/providers/shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "wan-2.2-animate",
]);

/**
 * What this model calls its fields on WaveSpeed.
 *
 * Every one is written out even though both sides use the same word: that is
 * what keeps our vocabulary and the vendor's independent (user 2026-08-10), so
 * a rename upstream is one line here rather than a hunt for a name that was
 * riding along by coincidence.
 */
const MODEL_FIELDS: Readonly<Record<string, Readonly<Record<string, FieldNames>>>> = {
  "wan-2.2-animate": {
    wavespeed: {
      image: "image",
      video: "video",
      resolution: "resolution",
      seed: "seed",
    },
  },
};

/**
 * WaveSpeed's `wavespeed-ai/wan-2.2/animate` requires a `mode` that selects
 * animation over character replacement. It is not a knob the user turns, so it
 * is not a catalog param: replacing a character inside an existing video is a
 * mini-tool operation on that video, not generation (#1917), and our own
 * `mode` already names something else entirely — a model's generation mode.
 */
const UPSTREAM_MODE = "animate";

/**
 * Convert user-facing params to provider-specific API params.
 * @param prompt - User's video description, returned unchanged
 * @param modelName - Resolved model name, which picks the name table
 * @param params - Validated params from YAML defaults + user input
 * @param providerName - Target provider (WaveSpeed is the only one)
 * @returns Tuple of [prompt, apiParams]
 */
export async function buildRequest(
  prompt: string,
  modelName: string,
  params: Record<string, unknown>,
  providerName?: string,
): Promise<[string, Record<string, unknown>]> {
  const names = MODEL_FIELDS[modelName]?.[providerName ?? "wavespeed"] ?? {};
  const api = applyFieldNames(params, names);
  // Ours, not the vendor's: -1 is how the catalog says "pick one for me".
  if (api.seed === -1) delete api.seed;
  api.mode = UPSTREAM_MODE;
  return [prompt, api];
}

export default { MODELS, buildRequest } satisfies ModelFamily;
