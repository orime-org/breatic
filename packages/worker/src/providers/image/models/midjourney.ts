// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Midjourney model family -- artistic image generation.
 *
 * Strips the resolution param (API does not accept it). Passes through
 * all other Midjourney-specific params. Uses plain text prompts.
 *
 * Parameter mapping (YAML user-facing vs API):
 * - aspect_ratio -> pass-through
 * - resolution   -> stripped
 * - stylize, chaos, weird, sref, seed -> pass-through
 */

import type { ModelFamily } from "@worker/providers/shared.js";

/**
 * Set of model names belonging to this family.
 *
 * WaveSpeed delisted the niji variant and both img2img endpoints
 * (2026-07-15 audit, #1683) — only V7 text-to-image remains live.
 */
export const MODELS: ReadonlySet<string> = new Set([
  "midjourney-v7",
]);

/**
 * Strip resolution, keep text prompt and Midjourney-specific params.
 * @param prompt - User's image description
 * @param _modelName - Resolved model name (unused; request shaping is the same across Midjourney models)
 * @param params - Validated params with aspect_ratio, stylize, chaos, etc.
 * @returns Tuple of [textPrompt, apiParams]
 */
export async function buildRequest(
  prompt: string,
  _modelName: string,
  params: Record<string, unknown>,
): Promise<[string, Record<string, unknown>]> {
  const p = { ...params };
  delete p.resolution;
  return [prompt, p];
}

export default { MODELS, buildRequest } satisfies ModelFamily;
