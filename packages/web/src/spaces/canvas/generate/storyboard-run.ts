// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The multi-shot mode's part of one video run, one answer for the submit's
 * gate and its payload.
 *
 * Outside that mode the main prompt goes out and nothing else. In it every
 * shot goes out in place of the main prompt -- in Kling's own field, or
 * written into one prompt for a model with no field for shots -- and those
 * same shots are what the execute gate judges. The shots' words are read
 * straight off their fragments (`fragment-prompt.ts`), so what is judged and
 * what is sent are the same string.
 */

import { storyboardSend, type ExecuteGateInput, type StoryboardSpec } from '@breatic/shared';
import type * as Y from 'yjs';

import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { serializePromptFragment } from '@web/spaces/canvas/generate/fragment-prompt';
import type { MentionTokens } from '@web/spaces/canvas/generate/reference-urls';

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
 * The shots' part of a run.
 * @param spec - The current model's storyboard in the current mode (`storyboardSpec`), undefined outside the multi-shot mode.
 * @param shots - The node's shots, in order.
 * @param total - The run's total seconds.
 * @param pool - The node's reference rows, for what a text chip says.
 * @param tokens - Each media chip's words, by source id.
 * @returns What goes into the run.
 */
export function storyboardRun(
  spec: StoryboardSpec | undefined,
  shots: ReadonlyArray<{ readonly prompt: Y.XmlFragment; readonly duration: number }>,
  total: number,
  pool: ReadonlyArray<ReferenceRailItem>,
  tokens: MentionTokens,
): StoryboardRun {
  if (spec === undefined) return NONE;
  const written = shots.map((shot) => ({
    prompt: serializePromptFragment(shot.prompt, pool, tokens),
    duration: shot.duration,
  }));
  const send = storyboardSend(spec, written);
  return {
    sendsPrompt: false,
    writtenPrompt: send.prompt,
    params: send.params,
    gate: {
      shots: written.map((shot) => ({ text: shot.prompt, duration: shot.duration })),
      total,
      maxShots: spec.maxShots,
      maxChars: spec.maxChars,
    },
  };
}
