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
 * animation over character replacement. It is not a catalog param: our own
 * `mode` already names something else entirely — a model's generation mode —
 * and the generation panel offers animation only.
 *
 * Written unconditionally, which is correct only while animation is the one
 * thing this family is asked for. `MINI_TOOL_REGISTRY.video.animate` points at
 * this same model and would reach this same function, so whoever wires
 * character replacement (#1917) has to branch here rather than pass a param:
 * an unknown param is dropped with a warn upstream of this, and this line
 * would then overwrite the intent with animation and bill for the wrong run.
 * That entry has no caller today.
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
  // Dropped under OUR name, before the rename: -1 is the catalog's "pick one
  // for me", and reading it back under the vendor's name would make this line
  // silently stop working the day that name changes -- which is exactly the
  // one-line change MODEL_FIELDS promises is safe. Same order as seedance.
  //
  // The vendor happens to spell its own default the same way (-1, documented
  // as "a random seed will be used"), so sending it would be equivalent; it
  // goes out under no name at all rather than relying on that staying true.
  const cleaned = { ...params };
  if (cleaned.seed === -1) delete cleaned.seed;
  const names = MODEL_FIELDS[modelName]?.[providerName ?? "wavespeed"] ?? {};
  const api = applyFieldNames(cleaned, names);
  api.mode = UPSTREAM_MODE;
  return [prompt, api];
}

export default { MODELS, buildRequest } satisfies ModelFamily;
