// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The storyboard's part of one video run (#2218, design §6), one answer for
 * the button, the submit and the payload.
 *
 * Off sends the main prompt and nothing else; the automatic tier sends the
 * main prompt and names itself; the per-shot tier sends every shot in place of
 * the main prompt, and those same shots are what the execute gate judges. The
 * shots' words are read straight off their fragments (`fragment-prompt.ts`),
 * so what is judged and what is sent are the same string.
 */

import {
  storyboardParams,
  type ExecuteGateInput,
  type StoryboardKind,
  type StoryboardSpec,
} from '@breatic/shared';
import type * as Y from 'yjs';

import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { serializePromptFragment } from '@web/spaces/canvas/generate/fragment-prompt';
import type { MentionTokens } from '@web/spaces/canvas/generate/reference-urls';

/** What the storyboard adds to a run. */
export interface StoryboardRun {
  /** Whether the main prompt goes out; false only under the per-shot tier. */
  readonly sendsPrompt: boolean;
  /** The params to merge into the payload. */
  readonly params: Record<string, unknown>;
  /** The shots for the execute gate, under the per-shot tier only. */
  readonly gate: ExecuteGateInput['storyboard'];
}

/** No storyboard in the run. */
const OFF: StoryboardRun = { sendsPrompt: true, params: {}, gate: undefined };

/**
 * The storyboard's part of a run.
 * @param spec - The current model's storyboard, undefined for a model with none.
 * @param kind - The tier stored for the current mode.
 * @param shots - The mode's shots, in order.
 * @param total - The run's total seconds.
 * @param pool - The node's reference rows, for what a text chip says.
 * @param tokens - Each media chip's words, by source id.
 * @returns What goes into the run.
 */
export function storyboardRun(
  spec: StoryboardSpec | undefined,
  kind: StoryboardKind,
  shots: ReadonlyArray<{ readonly prompt: Y.XmlFragment; readonly duration: number }>,
  total: number,
  pool: ReadonlyArray<ReferenceRailItem>,
  tokens: MentionTokens,
): StoryboardRun {
  if (spec === undefined || kind === 'off') return OFF;
  if (kind === 'auto') return { sendsPrompt: true, params: storyboardParams(spec, 'auto', []), gate: undefined };
  const written = shots.map((shot) => ({
    prompt: serializePromptFragment(shot.prompt, pool, tokens),
    duration: shot.duration,
  }));
  return {
    sendsPrompt: false,
    params: storyboardParams(spec, 'custom', written),
    gate: {
      shots: written.map((shot) => ({ text: shot.prompt, duration: shot.duration })),
      total,
      maxShots: spec.maxShots,
      maxChars: spec.maxChars,
    },
  };
}
