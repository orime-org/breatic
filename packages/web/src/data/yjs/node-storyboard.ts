// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A video node's shots, which only the multi-shot mode uses.
 *
 * The shape, born with the node in `buildDataMap`:
 * `data.shots: Y.Array<Y.Map{ id, prompt, duration }>`.
 * What each edit writes lives in `@breatic/shared/canvas-model`
 * (`storyboard-shots.ts`), so collab edits shots the same way (breatic#1488
 * §8.1); each export here is a thin shell that asks the size cap and runs that
 * body in one `CANVAS_UNDO` transaction.
 */

import type * as Y from 'yjs';
import {
  addStoryboardShotInDoc,
  enterStoryboardShotsInDoc,
  removeStoryboardShotInDoc,
  retotalStoryboardInDoc,
  setStoryboardShotsInDoc,
  shotView,
  shotsIn,
  stepStoryboardShotInDoc,
  type StoryboardShotView,
} from '@breatic/shared/canvas-model';

import { CANVAS_UNDO } from '@web/data/yjs/canvas-space';
import { docName, getDoc } from '@web/data/yjs/manager';
import { writeSpaceDoc, type SpaceWriteKind } from '@web/data/yjs/space-write';

export type { StoryboardShotView };

/**
 * The live shots array of a video node, for a reader that follows it.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @returns The array, or null when the node has none.
 */
export function shotListOf(projectId: string, spaceId: string, nodeId: string): Y.Array<Y.Map<unknown>> | null {
  return shotsIn(getDoc(docName.canvasSpace(projectId, spaceId)), nodeId);
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
 * What entering the multi-shot mode produces: laying out the two first shots
 * is an add, re-splitting existing ones an edit.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @returns The kind.
 */
export function storyboardEntryKind(projectId: string, spaceId: string, nodeId: string): SpaceWriteKind {
  const shots = shotListOf(projectId, spaceId, nodeId);
  return shots && shots.length > 0 ? 'edit' : 'add';
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
  const name = docName.canvasSpace(projectId, spaceId);
  const doc = getDoc(name);
  if (!shotsIn(doc, nodeId)) return;
  writeSpaceDoc(name, { kind: storyboardEntryKind(projectId, spaceId, nodeId) }, () => {
    doc.transact(() => enterStoryboardShotsInDoc(doc, nodeId, total), CANVAS_UNDO);
  });
}

/**
 * Adds a shot at the end, its seconds taken from the longest shots.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The video node.
 * @param total - The model's total seconds.
 * @param maxShots - The shot cap.
 * @returns The new shot's id, or null when no shot could be added.
 */
export function addStoryboardShot(
  projectId: string,
  spaceId: string,
  nodeId: string,
  total: number,
  maxShots: number,
): string | null {
  const name = docName.canvasSpace(projectId, spaceId);
  const doc = getDoc(name);
  if (!shotsIn(doc, nodeId)) return null;
  let added: string | null = null;
  writeSpaceDoc(name, { kind: 'add' }, () => {
    doc.transact(() => {
      added = addStoryboardShotInDoc(doc, nodeId, total, maxShots);
    }, CANVAS_UNDO);
  });
  return added;
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
  const name = docName.canvasSpace(projectId, spaceId);
  const doc = getDoc(name);
  if (!shotsIn(doc, nodeId)) return;
  writeSpaceDoc(name, { kind: 'edit' }, () => {
    doc.transact(() => stepStoryboardShotInDoc(doc, nodeId, shotId, delta), CANVAS_UNDO);
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
  const name = docName.canvasSpace(projectId, spaceId);
  const doc = getDoc(name);
  if (!shotsIn(doc, nodeId)) return;
  // Its seconds go to the previous shot, a rewrite beside the delete.
  writeSpaceDoc(name, { kind: 'compound' }, () => {
    doc.transact(() => removeStoryboardShotInDoc(doc, nodeId, shotId, total), CANVAS_UNDO);
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
  const name = docName.canvasSpace(projectId, spaceId);
  const doc = getDoc(name);
  if (!shotsIn(doc, nodeId)) return;
  writeSpaceDoc(name, { kind: 'edit' }, () => {
    doc.transact(() => retotalStoryboardInDoc(doc, nodeId, total), CANVAS_UNDO);
  });
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
  const name = docName.canvasSpace(projectId, spaceId);
  const doc = getDoc(name);
  if (!shotsIn(doc, nodeId)) return [];
  let fresh: Y.XmlFragment[] = [];
  const landed = writeSpaceDoc(name, { kind: 'add' }, () => {
    doc.transact(() => {
      fresh = setStoryboardShotsInDoc(doc, nodeId, durations);
    }, CANVAS_UNDO);
  }).ok;
  return landed ? fresh : [];
}
