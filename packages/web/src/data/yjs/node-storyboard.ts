// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A video node's shots, which only the multi-shot mode uses.
 *
 * The shape, born with the node in `canvas-space.ts`:
 * `data.shots: Y.Array<Y.Map{ id, prompt, duration }>`.
 * A shot is inserted whole with its own prompt fragment, so two people adding
 * a shot at once both keep theirs (array inserts commute). Durations move
 * through the pure rules in `@breatic/shared`'s `storyboard-durations`, which
 * every edit here applies and writes back in one transaction.
 */

import * as Y from 'yjs';
import { addShot, enterCustom, newId, removeShot, retotal, stepShot } from '@breatic/shared';

import { CANVAS_UNDO, nodeDataMap } from '@web/data/yjs/canvas-space';
import { docName, getDoc } from '@web/data/yjs/manager';
import { estimateNodeBytes, writeSpaceDoc, type SpaceWriteOptions } from '@web/data/yjs/space-write';

/** One shot as read off the document. */
export interface StoryboardShotView {
  readonly id: string;
  readonly prompt: Y.XmlFragment;
  readonly duration: number;
}

/**
 * The live shots array of a video node, for a reader that follows it.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @returns The array, or null when the node has none.
 */
export function shotListOf(projectId: string, spaceId: string, nodeId: string): Y.Array<Y.Map<unknown>> | null {
  const shots = nodeDataMap(getDoc(docName.canvasSpace(projectId, spaceId)), nodeId)?.get('shots');
  return shots instanceof Y.Array ? (shots as Y.Array<Y.Map<unknown>>) : null;
}

/**
 * A shot's seconds, zero when it holds none.
 * @param shot - The shot map.
 * @returns Its seconds.
 */
function durationOf(shot: Y.Map<unknown>): number {
  const duration = shot.get('duration');
  return typeof duration === 'number' ? duration : 0;
}

/**
 * One shot map read as a view.
 * @param shot - The shot map.
 * @returns The view, or null for a malformed entry.
 */
function shotView(shot: Y.Map<unknown>): StoryboardShotView | null {
  const id = shot.get('id');
  const prompt = shot.get('prompt');
  if (typeof id !== 'string' || !(prompt instanceof Y.XmlFragment)) return null;
  return { id, prompt, duration: durationOf(shot) };
}

/**
 * Reads a video node's shots.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @returns The shots, or null when the node has no list of them.
 */
export function readShots(projectId: string, spaceId: string, nodeId: string): StoryboardShotView[] | null {
  const shots = shotListOf(projectId, spaceId, nodeId);
  return shots ? shots.toArray().flatMap((shot) => shotView(shot) ?? []) : null;
}

/**
 * A new shot map, born with its own prompt fragment.
 * @param duration - Its seconds.
 * @returns The shot map.
 */
function newShot(duration: number): Y.Map<unknown> {
  const shot = new Y.Map<unknown>();
  shot.set('id', newId());
  shot.set('prompt', new Y.XmlFragment());
  shot.set('duration', duration);
  return shot;
}

/** What one shot is estimated as, for the size cap. */
const SHOT_ESTIMATE = { id: '00000000-0000-0000-0000-000000000000', prompt: '', duration: 0 };

/**
 * How laying out new shots is judged.
 * @param count - How many shots are laid out.
 * @returns An add of that many shots.
 */
function shotsAdded(count: number): SpaceWriteOptions {
  return { kind: 'add', estimate: count * estimateNodeBytes(SHOT_ESTIMATE) };
}

/**
 * Applies one edit to a node's shots in one transaction.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @param judged - What the edit does to the document's size (inner#1790).
 * @param edit - Given the shots array and their durations, applies the change.
 * @returns Whether the node has shots to edit and the size cap let the edit in.
 */
function editShots(
  projectId: string,
  spaceId: string,
  nodeId: string,
  judged: SpaceWriteOptions,
  edit: (shots: Y.Array<Y.Map<unknown>>, durations: number[]) => void,
): boolean {
  const shots = shotListOf(projectId, spaceId, nodeId);
  if (!shots) return false;
  return writeSpaceDoc(docName.canvasSpace(projectId, spaceId), judged, () => {
    shots.doc?.transact(() => {
      edit(shots, shots.toArray().map(durationOf));
    }, CANVAS_UNDO);
  }).ok;
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
 * How entering the multi-shot mode is judged: laying out the two first
 * shots is an add, re-splitting existing ones an overwrite.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @returns The options.
 */
export function storyboardEntryWrite(projectId: string, spaceId: string, nodeId: string): SpaceWriteOptions {
  const shots = shotListOf(projectId, spaceId, nodeId);
  return shots && shots.length > 0 ? { kind: 'overwrite' } : shotsAdded(2);
}

/**
 * Enters the multi-shot mode: two shots when there are none, the existing
 * ones re-split to the total when they drifted from it.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @param total - The model's total seconds.
 */
export function enterStoryboardShots(projectId: string, spaceId: string, nodeId: string, total: number): void {
  editShots(projectId, spaceId, nodeId, storyboardEntryWrite(projectId, spaceId, nodeId), (shots, durations) => {
    const next = enterCustom(durations, total);
    if (shots.length === 0) shots.push(next.map((d) => newShot(d)));
    else writeDurations(shots, next);
  });
}

/**
 * Adds a shot at the end, its seconds taken from the longest shots.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @param total - The model's total seconds.
 * @param maxShots - The shot cap.
 */
export function addStoryboardShot(
  projectId: string,
  spaceId: string,
  nodeId: string,
  total: number,
  maxShots: number,
): void {
  editShots(projectId, spaceId, nodeId, shotsAdded(1), (shots, durations) => {
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
 * @param shotId - The shot being stepped.
 * @param delta - +1 or -1.
 */
export function stepStoryboardShot(
  projectId: string,
  spaceId: string,
  nodeId: string,
  shotId: string,
  delta: 1 | -1,
): void {
  editShots(projectId, spaceId, nodeId, { kind: 'overwrite' }, (shots, durations) => {
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
 * @param shotId - The shot to remove.
 * @param total - The model's total seconds.
 */
export function removeStoryboardShot(
  projectId: string,
  spaceId: string,
  nodeId: string,
  shotId: string,
  total: number,
): void {
  editShots(projectId, spaceId, nodeId, { kind: 'delete' }, (shots, durations) => {
    const index = shots.toArray().findIndex((shot) => shot.get('id') === shotId);
    const next = index === -1 ? null : removeShot(durations, index, total);
    if (!next) return;
    shots.delete(index, 1);
    writeDurations(shots, next);
  });
}

/**
 * Re-splits the shots to a new total. The panel calls it only while the
 * multi-shot mode is showing them.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @param total - The new total seconds.
 */
export function retotalStoryboard(projectId: string, spaceId: string, nodeId: string, total: number): void {
  editShots(projectId, spaceId, nodeId, { kind: 'overwrite' }, (shots, durations) => writeDurations(shots, retotal(durations, total)));
}

/**
 * Replaces the shots with fresh ones of the given seconds, for a proposal
 * landing on a new node.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @param durations - Each shot's seconds, in order.
 * @returns Each new shot's prompt fragment, in order; empty when the node has
 *   no list of shots or the size cap refused them.
 */
export function setStoryboardShots(
  projectId: string,
  spaceId: string,
  nodeId: string,
  durations: readonly number[],
): Y.XmlFragment[] {
  const fresh = durations.map((d) => newShot(d));
  const landed = editShots(projectId, spaceId, nodeId, shotsAdded(durations.length), (shots) => {
    shots.delete(0, shots.length);
    shots.push(fresh);
  });
  return landed ? fresh.map((shot) => shot.get('prompt') as Y.XmlFragment) : [];
}
