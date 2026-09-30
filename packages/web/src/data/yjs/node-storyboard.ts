// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A video node's storyboards: one per mode, each a tier and a list of shots
 * (#2218).
 *
 * The shape, born with the node in `canvas-space.ts`:
 * `data.storyboards: Y.Map<mode, Y.Map{ kind, shots: Y.Array<Y.Map{ id, prompt, duration }> }>`.
 * A shot is inserted whole with its own prompt fragment, so two people adding
 * a shot at once both keep theirs (array inserts commute). Durations move
 * through the pure rules in `@breatic/shared`'s `storyboard-durations`, which
 * every edit here applies and writes back in one transaction.
 */

import * as Y from 'yjs';
import {
  addShot,
  enterCustom,
  removeShot,
  retotal,
  stepShot,
  type StoryboardKind,
} from '@breatic/shared';

import { CANVAS_UNDO, nodeDataMap } from '@web/data/yjs/canvas-space';
import { docName, getDoc } from '@web/data/yjs/manager';

/** One shot as read off the document. */
export interface StoryboardShotView {
  readonly id: string;
  readonly prompt: Y.XmlFragment;
  readonly duration: number;
}

/** One mode's storyboard as read off the document. */
export interface StoryboardView {
  readonly kind: StoryboardKind;
  readonly shots: readonly StoryboardShotView[];
}

/**
 * The live storyboard map of one mode.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @param mode - The video mode.
 * @returns The map, or null when the node or that mode has none.
 */
function boardMap(
  projectId: string,
  spaceId: string,
  nodeId: string,
  mode: string,
): Y.Map<unknown> | null {
  const data = nodeDataMap(getDoc(docName.canvasSpace(projectId, spaceId)), nodeId);
  const boards = data?.get('storyboards');
  const board = boards instanceof Y.Map ? boards.get(mode) : undefined;
  return board instanceof Y.Map ? board : null;
}

/**
 * The shots array of a storyboard map.
 * @param board - The storyboard map.
 * @returns Its shots, or null when the map carries none.
 */
function shotsOf(board: Y.Map<unknown>): Y.Array<Y.Map<unknown>> | null {
  const shots = board.get('shots');
  return shots instanceof Y.Array ? (shots as Y.Array<Y.Map<unknown>>) : null;
}

/**
 * One shot map read as a view.
 * @param shot - The shot map.
 * @returns The view, or null for a malformed entry.
 */
function shotView(shot: Y.Map<unknown>): StoryboardShotView | null {
  const id = shot.get('id');
  const prompt = shot.get('prompt');
  const duration = shot.get('duration');
  if (typeof id !== 'string' || !(prompt instanceof Y.XmlFragment) || typeof duration !== 'number') {
    return null;
  }
  return { id, prompt, duration };
}

/**
 * Reads one mode's storyboard.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @param mode - The video mode.
 * @returns The storyboard, or null when the node or that mode has none.
 */
export function readStoryboard(
  projectId: string,
  spaceId: string,
  nodeId: string,
  mode: string,
): StoryboardView | null {
  const board = boardMap(projectId, spaceId, nodeId, mode);
  if (!board) return null;
  const kind = board.get('kind');
  const shots = shotsOf(board)?.toArray().flatMap((shot) => shotView(shot) ?? []) ?? [];
  return { kind: kind === 'auto' || kind === 'custom' ? kind : 'off', shots };
}

/**
 * Sets one mode's tier; the shots are kept whatever the tier becomes.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @param mode - The video mode.
 * @param kind - The tier to set.
 */
export function setStoryboardKind(
  projectId: string,
  spaceId: string,
  nodeId: string,
  mode: string,
  kind: StoryboardKind,
): void {
  const board = boardMap(projectId, spaceId, nodeId, mode);
  if (!board) return;
  board.doc?.transact(() => board.set('kind', kind), CANVAS_UNDO);
}

/**
 * A new shot map, born with its own prompt fragment.
 * @param duration - Its seconds.
 * @returns The shot map.
 */
function newShot(duration: number): Y.Map<unknown> {
  const shot = new Y.Map<unknown>();
  shot.set('id', crypto.randomUUID());
  shot.set('prompt', new Y.XmlFragment());
  shot.set('duration', duration);
  return shot;
}

/**
 * Runs a duration rule over one mode's shots and writes the result back in
 * one transaction.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @param mode - The video mode.
 * @param edit - Given the shots array and their durations, applies the change.
 */
function editShots(
  projectId: string,
  spaceId: string,
  nodeId: string,
  mode: string,
  edit: (shots: Y.Array<Y.Map<unknown>>, durations: number[]) => void,
): void {
  const board = boardMap(projectId, spaceId, nodeId, mode);
  const shots = board ? shotsOf(board) : null;
  if (!board || !shots) return;
  board.doc?.transact(() => {
    edit(shots, shots.toArray().map((shot) => Number(shot.get('duration')) || 0));
  }, CANVAS_UNDO);
}

/**
 * Writes durations onto the existing shots, one for one.
 * @param shots - The shots array.
 * @param durations - The new durations, in shot order.
 */
function writeDurations(shots: Y.Array<Y.Map<unknown>>, durations: readonly number[]): void {
  shots.toArray().forEach((shot, i) => {
    const next = durations[i];
    if (next !== undefined && shot.get('duration') !== next) shot.set('duration', next);
  });
}

/**
 * Enters the per-shot tier: two shots when there are none, the existing ones
 * re-split to the total otherwise.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @param mode - The video mode.
 * @param total - The model's total seconds.
 */
export function enterStoryboardShots(
  projectId: string,
  spaceId: string,
  nodeId: string,
  mode: string,
  total: number,
): void {
  const board = boardMap(projectId, spaceId, nodeId, mode);
  const shots = board ? shotsOf(board) : null;
  if (!board || !shots) return;
  board.doc?.transact(() => {
    const durations = enterCustom(shots.toArray().map((shot) => Number(shot.get('duration')) || 0), total);
    if (shots.length === 0) shots.push(durations.map((d) => newShot(d)));
    else writeDurations(shots, durations);
    board.set('kind', 'custom');
  }, CANVAS_UNDO);
}

/**
 * Adds a shot at the end, its seconds taken from the longest shots.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @param mode - The video mode.
 * @param total - The model's total seconds.
 * @param maxShots - The model's shot cap.
 */
export function addStoryboardShot(
  projectId: string,
  spaceId: string,
  nodeId: string,
  mode: string,
  total: number,
  maxShots: number,
): void {
  editShots(projectId, spaceId, nodeId, mode, (shots, durations) => {
    const next = addShot(durations, total, maxShots);
    if (!next) return;
    writeDurations(shots, next);
    shots.push([newShot(next[next.length - 1] ?? 1)]);
  });
}

/**
 * Moves one second into or out of a shot.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @param mode - The video mode.
 * @param shotId - The shot being stepped.
 * @param delta - +1 or -1.
 */
export function stepStoryboardShot(
  projectId: string,
  spaceId: string,
  nodeId: string,
  mode: string,
  shotId: string,
  delta: 1 | -1,
): void {
  editShots(projectId, spaceId, nodeId, mode, (shots, durations) => {
    const index = shots.toArray().findIndex((shot) => shot.get('id') === shotId);
    const next = index === -1 ? null : stepShot(durations, index, delta);
    if (next) writeDurations(shots, next);
  });
}

/**
 * Removes a shot, giving its seconds to the previous one.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @param mode - The video mode.
 * @param shotId - The shot to remove.
 * @param total - The model's total seconds.
 */
export function removeStoryboardShot(
  projectId: string,
  spaceId: string,
  nodeId: string,
  mode: string,
  shotId: string,
  total: number,
): void {
  editShots(projectId, spaceId, nodeId, mode, (shots, durations) => {
    const index = shots.toArray().findIndex((shot) => shot.get('id') === shotId);
    const next = index === -1 ? null : removeShot(durations, index, total);
    if (!next) return;
    shots.delete(index, 1);
    writeDurations(shots, next);
  });
}

/**
 * Re-splits one mode's shots to a new total, in the per-shot tier only.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @param mode - The video mode.
 * @param total - The new total seconds.
 */
export function retotalStoryboard(
  projectId: string,
  spaceId: string,
  nodeId: string,
  mode: string,
  total: number,
): void {
  if (readStoryboard(projectId, spaceId, nodeId, mode)?.kind !== 'custom') return;
  editShots(projectId, spaceId, nodeId, mode, (shots, durations) => {
    writeDurations(shots, retotal(durations, total));
  });
}
