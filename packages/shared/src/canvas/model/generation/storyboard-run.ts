// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The multi-shot mode's part of one video run, one answer for the submit's
 * gate and its payload.
 *
 * Outside that mode the main prompt goes out and nothing else. In it every
 * shot goes out in place of the main prompt -- in Kling's own field, or
 * written into one prompt for a model with no field for shots -- and those
 * same shots are what the execute gate judges. The caller writes each shot
 * out once, from its fragment in the browser (`fragment-prompt.ts`) or from
 * its pieces elsewhere (`prompt-pieces.ts`), so what is judged and what is
 * sent are the same string.
 */

import { type ExecuteGateInput } from '@shared/generate-guards.js';
import { storyboardSend, storyboardSpec, type StoryboardSpec } from '@shared/storyboard.js';
import { type ModelEntry } from '@shared/types/model-catalog.js';

/** What the shots add to a run. */
export interface StoryboardRun {
  /** Whether the main prompt goes out; false in the multi-shot mode. */
  readonly sendsPrompt: boolean;
  /** The prompt sent in place of the main one: the shots written out, for a model with no field for them. */
  readonly writtenPrompt: string | undefined;
  /** The params to merge into the payload. */
  readonly params: Record<string, unknown>;
  /** The shots for the execute gate, in the multi-shot mode only. */
  readonly gate: ExecuteGateInput['storyboard'];
}

/** No shots in the run. */
const NONE: StoryboardRun = { sendsPrompt: true, writtenPrompt: undefined, params: {}, gate: undefined };

/**
 * The storyboard a model runs in a mode, undefined outside the multi-shot mode.
 * @param entry - The model.
 * @param mode - The mode.
 * @returns Its storyboard.
 */
export function storyboardSpecOf(entry: ModelEntry | undefined, mode: string): StoryboardSpec | undefined {
  return entry ? storyboardSpec(entry.params, mode) : undefined;
}

/**
 * The run's total seconds, read off the param the storyboard names.
 * @param spec - The storyboard.
 * @param params - The run's params.
 * @returns The seconds, 0 when none are set.
 */
export function storyboardTotal(spec: StoryboardSpec | undefined, params: Readonly<Record<string, unknown>>): number {
  const raw = spec?.totalParam === undefined ? undefined : params[spec.totalParam];
  return typeof raw === 'number' ? raw : 0;
}

/**
 * The shots' part of a run.
 * @param spec - The current model's storyboard in the current mode (`storyboardSpecOf`), undefined outside the multi-shot mode.
 * @param shots - The node's shots, in order, each written out with the run's mention words.
 * @param total - The run's total seconds.
 * @returns What goes into the run.
 */
export function storyboardRun(
  spec: StoryboardSpec | undefined,
  shots: ReadonlyArray<{ readonly prompt: string; readonly duration: number }>,
  total: number,
): StoryboardRun {
  if (spec === undefined) return NONE;
  const send = storyboardSend(spec, shots);
  return {
    sendsPrompt: false,
    writtenPrompt: send.prompt,
    params: send.params,
    gate: {
      shots: shots.map((shot) => ({ text: shot.prompt, duration: shot.duration })),
      total,
      maxShots: spec.maxShots,
      maxChars: spec.maxChars,
    },
  };
}
