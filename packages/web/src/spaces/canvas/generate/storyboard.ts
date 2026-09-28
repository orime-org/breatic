// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A storyboard (#2156, design §13): shots, each with its own prompt and
 * length, standing in for the prompt box. The shots live under the model's
 * params like any other list, so switching the storyboard off keeps them for
 * next time; only the switch lives on the node.
 */

import type { StoryboardControl } from '@web/spaces/canvas/generate/model-controls';

/** One shot. */
export interface Shot {
  prompt: string;
  /** In seconds. */
  duration: number;
}

/** A model's storyboard on one node. */
export interface Storyboard {
  control: StoryboardControl;
  /** Whether the shots stand in for the prompt. */
  on: boolean;
  shots: Shot[];
}

/**
 * The shots a stored value holds. Node data is collaborative and untrusted:
 * anything that is not an object is dropped, a missing prompt reads as empty
 * and a length the model does not take reads as the one a new shot starts at.
 * @param held - What the node stores under the storyboard param.
 * @param control - The model's storyboard.
 * @returns The shots.
 */
export function readShots(held: unknown, control: StoryboardControl): Shot[] {
  if (!Array.isArray(held)) return [];
  const length = control.fields.find((f) => f.name === 'duration');
  const lengths = length?.kind === 'choice' ? length.options.map((o) => o.value) : [];
  const fallback = length?.kind === 'choice' ? Number(length.initial ?? lengths[0] ?? 0) : 0;
  return held
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null && !Array.isArray(e))
    .map((e) => ({
      prompt: typeof e.prompt === 'string' ? e.prompt : '',
      duration: typeof e.duration === 'number' && lengths.includes(e.duration) ? e.duration : fallback,
    }));
}

/**
 * The params a run sends once the storyboard has had its say: while it is on,
 * the shots and their total as the run's length; while it is off, no shots.
 * @param params - The model's resolved params.
 * @param board - The node's storyboard, or undefined for a model without one.
 * @returns The params to send.
 */
export function storyboardParams(
  params: Record<string, unknown>,
  board: Storyboard | undefined,
): Record<string, unknown> {
  if (!board) return params;
  const { [board.control.name]: _held, ...rest } = params;
  if (!board.on) return rest;
  const total = board.shots.reduce((sum, s) => sum + s.duration, 0);
  return { ...rest, duration: total, [board.control.name]: board.shots };
}
