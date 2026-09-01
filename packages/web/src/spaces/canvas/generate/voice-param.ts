// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Locating and reading the param the voice picker fills (#1960).
 *
 * The two tts models spell the same choice differently — ElevenLabs takes
 * `voice_id`, Fish takes `reference_id` — so the picker finds its param by the
 * `remote_source` marker each declares in yaml rather than by name. Writing one
 * shared name instead fails silently: the worker drops a param the model never
 * declared (`shared.ts`'s `unknown_param_dropped`), generation succeeds, and
 * what comes back is the vendor's own default voice.
 *
 * The value lives in the node's per-model record (`model-params.ts`), which is
 * also where the picker writes, so a choice survives a model switch and reaches
 * the request through the path the other params already take.
 */

import type { ModelEntry } from '@breatic/shared';

/**
 * The name of this model's voice param, if it has one.
 * @param model - The selected model, or undefined before one is picked.
 * @returns The param name, or null when this model takes no voice.
 */
export function voiceParamName(model: ModelEntry | undefined): string | null {
  if (!model) return null;
  for (const [name, descriptor] of Object.entries(model.params)) {
    if (descriptor.remote_source === 'voices') return name;
  }
  return null;
}

/**
 * Whether the user has picked a voice for this model.
 *
 * Reads the RECORD, not the resolved value: resolution falls back to the yaml
 * default, and neither model's default is a voice this deployment can use —
 * Fish declares `null`, which `transports/fish.ts` guards away so no voice is
 * sent at all, and ElevenLabs declares `"Alice"`, a display name the direct
 * connection rejects. Both must read as "not chosen" so the panel can say so.
 * @param record - This model's param record off the node, if it has one.
 * @param paramName - The name {@link voiceParamName} answered.
 * @returns True when the record holds a usable id for that param.
 */
export function isVoiceChosen(
  record: Record<string, unknown> | undefined,
  paramName: string,
): boolean {
  const value = record?.[paramName];
  return typeof value === 'string' && value.length > 0;
}
