// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the 3D generation dialog, its task rows and the Agent's proposal card
 * share (inner#1691, design 2.1 and 7.1): the two generation modes, which
 * catalog entry a run goes to, which settings every entry has, and what the
 * dialog is filled with when it opens from a proposal or a retry.
 */

import { modesOf, picturesOf, type ModelEntry, type SceneGenerationProposal, type ThreeDGenerationMode } from '@breatic/shared';

import type { SpaceTask } from '@web/data/api/scene';
import type { SceneGenerateFill } from '@web/stores/scene-proposals';
import { spaceTaskIntent } from '@web/stores/task-actions-in-flight';

/** Mode names, English only like every generation mode name. */
export const SCENE_MODE_LABELS: Readonly<Record<ThreeDGenerationMode, string>> = {
  t23d: 'Text to 3D',
  i23d: 'Image to 3D',
};

/**
 * The run-once intent of one 3D Space's generate press.
 * @param spaceId - The 3D Space.
 * @returns The intent its button and its proposal receiver read.
 */
export function sceneGenerateIntent(spaceId: string): string {
  return spaceTaskIntent('generate', spaceId, 'scene-generate');
}

/**
 * Read a mode off the wire, which says it as a plain string.
 * @param mode - The mode as stored.
 * @returns The mode; text when it is not an image mode.
 */
function modeOf(mode: string | undefined): ThreeDGenerationMode {
  return mode === 'i23d' ? 'i23d' : 't23d';
}

/**
 * The catalog entry a run goes to (design 2.1): the text entry, or for images
 * the single-image entry while only the front view is filled and the
 * multi-view entry once another view is.
 * @param entries - The catalog's 3D bucket.
 * @param mode - The mode.
 * @param views - How many views are filled.
 * @returns The entry, or undefined before the catalog holds one.
 */
export function sceneEntryFor(entries: readonly ModelEntry[], mode: ThreeDGenerationMode, views: number): ModelEntry | undefined {
  const inMode = entries.filter((entry) => modesOf(entry).includes(mode));
  if (mode === 't23d') return inMode[0];
  return inMode.find((entry) => picturesOf(entry)?.list === (views > 1)) ?? inMode[0];
}

/**
 * The settings every 3D entry declares, which the dialog draws above the
 * mode's own section (design 2.3).
 * @param entries - The catalog's 3D bucket.
 * @returns Their param names.
 */
export function commonSceneParams(entries: readonly ModelEntry[]): ReadonlySet<string> {
  const [first, ...rest] = entries;
  if (first === undefined) return new Set();
  return new Set(Object.keys(first.params).filter((name) => rest.every((entry) => entry.params[name] !== undefined)));
}

/**
 * The dialog's fill for an Agent proposal.
 * @param proposal - The proposal the card handed in.
 * @returns The fill.
 */
export function fillFromProposal(proposal: SceneGenerationProposal): SceneGenerateFill {
  return { source: 'agent', origin: 'agent', mode: proposal.mode, prompt: proposal.prompt ?? '', params: proposal.params, images: proposal.images };
}

/**
 * The dialog's fill for a Retry of a generation row (design 4.6); the new run keeps the row's origin.
 * @param task - The generation row.
 * @returns The fill.
 */
export function fillFromTask(task: SpaceTask): SceneGenerateFill {
  return {
    source: 'retry', origin: task.origin ?? 'space', mode: modeOf(task.mode),
    prompt: task.prompt ?? '', params: task.params ?? {}, images: task.inputs ?? [],
  };
}
