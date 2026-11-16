// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A video node's shots, which only the multi-shot mode uses (breatic#1488
 * §8.1: the bodies collab and web both write them with).
 *
 * The shape, born with the node in `buildDataMap`:
 * `data.shots: Y.Array<Y.Map{ id, prompt, duration }>`.
 * A shot is inserted whole with its own prompt fragment, so two people adding
 * a shot at once both keep theirs (array inserts commute). Durations move
 * through the pure rules in `storyboard-durations`, which every edit here
 * applies and writes back. A body never opens a transaction; the caller owns
 * it and its origin.
 */

import * as Y from 'yjs';

import { newId } from '@shared/ids.js';
import { addShot, enterCustom, removeShot, retotal, stepShot } from '@shared/storyboard-durations.js';
import { nodeDataMap } from '@shared/canvas/model/canvas-read.js';

/** One shot as read off the document. */
export interface StoryboardShotView {
  readonly id: string;
  readonly prompt: Y.XmlFragment;
  readonly duration: number;
}

/**
 * The live shots array of a video node.
 * @param doc - The canvas document.
 * @param nodeId - The video node.
 * @returns The array, or null when the node has none.
 */
export function shotsIn(doc: Y.Doc, nodeId: string): Y.Array<Y.Map<unknown>> | null {
  const shots = nodeDataMap(doc, nodeId)?.get('shots');
  return shots instanceof Y.Array ? (shots as Y.Array<Y.Map<unknown>>) : null;
}

/**
 * A shot's seconds, zero when it holds none.
 * @param shot - The shot map.
 * @returns Its seconds.
 */
export function durationOf(shot: Y.Map<unknown>): number {
  const duration = shot.get('duration');
  return typeof duration === 'number' ? duration : 0;
}

/**
 * One shot map read as a view.
 * @param shot - The shot map.
 * @returns The view, or null for a malformed entry.
 */
export function shotView(shot: Y.Map<unknown>): StoryboardShotView | null {
  const id = shot.get('id');
  const prompt = shot.get('prompt');
  if (typeof id !== 'string' || !(prompt instanceof Y.XmlFragment)) return null;
  return { id, prompt, duration: durationOf(shot) };
}

/**
 * A new shot map, born with its own prompt fragment.
 * @param duration - Its seconds.
 * @returns The shot map.
 */
export function newShot(duration: number): Y.Map<unknown> {
  const shot = new Y.Map<unknown>();
  shot.set('id', newId());
  shot.set('prompt', new Y.XmlFragment());
  shot.set('duration', duration);
  return shot;
}

/**
 * Writes durations onto the existing shots, one for one.
 * @param shots - The shots array.
 * @param durations - The new durations, in shot order.
 */
export function writeDurations(shots: Y.Array<Y.Map<unknown>>, durations: readonly number[]): void {
  shots.toArray().forEach((shot, i) => {
    const next = durations[i];
    if (next !== undefined && shot.get('duration') !== next) shot.set('duration', next);
  });
}

/**
 * Each shot's seconds, in order.
 * @param shots - The shots array.
 * @returns The durations.
 */
function durationsOf(shots: Y.Array<Y.Map<unknown>>): number[] {
  return shots.toArray().map(durationOf);
}

/**
 * Enters the multi-shot mode: two shots when there are none, the existing
 * ones re-split to the total when they drifted from it.
 * @param doc - The canvas document.
 * @param nodeId - The video node.
 * @param total - The model's total seconds.
 */
export function enterStoryboardShotsInDoc(doc: Y.Doc, nodeId: string, total: number): void {
  const shots = shotsIn(doc, nodeId);
  if (!shots) return;
  const next = enterCustom(durationsOf(shots), total);
  if (shots.length === 0) shots.push(next.map((d) => newShot(d)));
  else writeDurations(shots, next);
}

/**
 * Adds a shot at the end, its seconds taken from the longest shots.
 * @param doc - The canvas document.
 * @param nodeId - The video node.
 * @param total - The model's total seconds.
 * @param maxShots - The shot cap.
 * @returns The new shot's id, or null when no shot could be added.
 */
export function addStoryboardShotInDoc(doc: Y.Doc, nodeId: string, total: number, maxShots: number): string | null {
  const shots = shotsIn(doc, nodeId);
  if (!shots) return null;
  const next = addShot(durationsOf(shots), total, maxShots);
  if (!next) return null;
  writeDurations(shots, next);
  const shot = newShot(next[next.length - 1] ?? 1);
  shots.push([shot]);
  return shot.get('id') as string;
}

/**
 * Moves one second into or out of a shot.
 * @param doc - The canvas document.
 * @param nodeId - The video node.
 * @param shotId - The shot being stepped.
 * @param delta - +1 or -1.
 */
export function stepStoryboardShotInDoc(doc: Y.Doc, nodeId: string, shotId: string, delta: 1 | -1): void {
  const shots = shotsIn(doc, nodeId);
  if (!shots) return;
  const index = shots.toArray().findIndex((shot) => shot.get('id') === shotId);
  const next = index === -1 ? null : stepShot(durationsOf(shots), index, delta);
  if (next) writeDurations(shots, next);
}

/**
 * Removes a shot, giving its seconds to the previous one.
 * @param doc - The canvas document.
 * @param nodeId - The video node.
 * @param shotId - The shot to remove.
 * @param total - The model's total seconds.
 */
export function removeStoryboardShotInDoc(doc: Y.Doc, nodeId: string, shotId: string, total: number): void {
  const shots = shotsIn(doc, nodeId);
  if (!shots) return;
  const index = shots.toArray().findIndex((shot) => shot.get('id') === shotId);
  const next = index === -1 ? null : removeShot(durationsOf(shots), index, total);
  if (!next) return;
  shots.delete(index, 1);
  writeDurations(shots, next);
}

/**
 * Re-splits the shots to a new total.
 * @param doc - The canvas document.
 * @param nodeId - The video node.
 * @param total - The new total seconds.
 */
export function retotalStoryboardInDoc(doc: Y.Doc, nodeId: string, total: number): void {
  const shots = shotsIn(doc, nodeId);
  if (!shots) return;
  writeDurations(shots, retotal(durationsOf(shots), total));
}

/**
 * Replaces the shots with fresh ones of the given seconds, for a proposal
 * landing on a new node.
 * @param doc - The canvas document.
 * @param nodeId - The video node.
 * @param durations - Each shot's seconds, in order.
 * @returns Each new shot's prompt fragment, in order; empty when the node has no list of shots.
 */
export function setStoryboardShotsInDoc(doc: Y.Doc, nodeId: string, durations: readonly number[]): Y.XmlFragment[] {
  const shots = shotsIn(doc, nodeId);
  if (!shots) return [];
  const fresh = durations.map((d) => newShot(d));
  shots.delete(0, shots.length);
  shots.push(fresh);
  return fresh.map((shot) => shot.get('prompt') as Y.XmlFragment);
}
