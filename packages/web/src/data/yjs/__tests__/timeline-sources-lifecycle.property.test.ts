// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Sources follow the clips across collaborating sessions (inner#1708 L9, design §3.4, §3.6).
 *
 * Two replicas, each with its own edit session, run a random sequence of additions, splits, duplicates, deletes,
 * moves, undos and redos with random sync points. After a full sync no clip may name a missing source, and after
 * one more edit the stored sources are exactly the ones the clips reference.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import type { TimelineVideoSource } from '@breatic/shared';

import { _resetForTests } from '@web/data/yjs/manager';
import { applyTimelineEdit, readTimelineDocument } from '@web/data/yjs/timeline-document';
import type { TimelineEditCommand } from '@web/data/yjs/timeline-edit';
import { evictTimelineEditSession, getTimelineEditSession, type TimelineEditSession } from '@web/data/yjs/timeline-edit-session';
import { MAIN, SHORT_SOURCE, SOURCE, cid, clip, seededDoc, timeline } from '@web/data/yjs/__tests__/timeline-document-fixtures';

const FINAL = Symbol('final-edit');
const UNTRACKED = Symbol('untracked-edit');
const ACTIONS = ['add', 'split', 'duplicate', 'delete', 'move', 'undo', 'redo', 'untracked-delete'] as const;

const action = fc.record({
  replica: fc.integer({ min: 0, max: 1 }),
  kind: fc.constantFrom(...ACTIONS),
  pick: fc.nat(),
  sourcePick: fc.integer({ min: 0, max: 2 }),
  frame: fc.integer({ min: 0, max: 400 }),
  length: fc.integer({ min: 1, max: 30 }),
  onMain: fc.boolean(),
  magnet: fc.boolean(),
  syncAfter: fc.boolean(),
});
type Action = typeof action extends fc.Arbitrary<infer T> ? T : never;

afterEach(() => {
  _resetForTests();
});

/**
 * Exchange every update between the replicas.
 * @param a - One replica.
 * @param b - The other replica.
 * @throws {never} Never.
 */
function exchange(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

/**
 * The source ids the clip records name, valid or damaged.
 * @param doc - The replica.
 * @returns The sorted ids.
 * @throws {never} Never.
 */
function referenced(doc: Y.Doc): string[] {
  const ids = new Set<string>();
  for (const record of doc.getMap('clips').values()) {
    const sourceId = record instanceof Y.Map ? record.get('sourceId') : undefined;
    if (typeof sourceId === 'string') ids.add(sourceId);
  }
  return [...ids].sort();
}

/**
 * The stored source ids.
 * @param doc - The replica.
 * @returns The sorted ids.
 * @throws {never} Never.
 */
function stored(doc: Y.Doc): string[] {
  return [...doc.getMap('sources').keys()].sort();
}

/**
 * A full-length source shaped like SOURCE under a new identity.
 * @param n - Its ordinal.
 * @returns The source.
 * @throws {never} Never.
 */
function freshSource(n: number): TimelineVideoSource {
  const suffix = String(n).padStart(12, '0');
  return { ...SOURCE, id: `10000000-0000-4000-8000-${suffix}`, assetId: `20000000-0000-4000-8000-${suffix}` };
}

/**
 * Build the edit one action asks for on a replica, or null when it has nothing to act on.
 * @param doc - The replica.
 * @param step - The action.
 * @param next - Supplies new ordinals for clip and source ids.
 * @returns The command, or null.
 * @throws {Error} When the replica cannot be read.
 */
function commandFor(doc: Y.Doc, step: Action, next: () => number): TimelineEditCommand | null {
  const placement = { magnet: step.magnet, linkage: step.magnet };
  const trackId = step.onMain ? MAIN : 'v2';
  if (step.kind === 'add') {
    const source = [SOURCE, SHORT_SOURCE, freshSource(next())][step.sourcePick] ?? SOURCE;
    return { operation: 'add_video', parameters: { source, clip: clip(cid(next()), trackId, step.frame, step.length, { sourceId: source.id }) }, placement };
  }
  const document = readTimelineDocument(doc);
  const ids = Object.keys(document.clips).sort();
  const subjectId = ids[step.pick % Math.max(1, ids.length)];
  const subject = subjectId === undefined ? undefined : document.clips[subjectId];
  if (subject === undefined) return null;
  switch (step.kind) {
    case 'split':
      return subject.durationFrames < 2 ? null
        : { operation: 'split', parameters: { clipId: subject.id, frame: subject.startFrame + 1 + (step.pick % (subject.durationFrames - 1)), newClipId: cid(next()) }, placement };
    case 'duplicate': return { operation: 'duplicate', parameters: { clipId: subject.id, newClipId: cid(next()) }, placement };
    case 'move': return { operation: 'move', parameters: { clipId: subject.id, startFrame: step.frame, trackId }, placement };
    default: return { operation: 'delete', parameters: { clipId: subject.id }, placement };
  }
}

describe('Timeline sources across two collaborating sessions (inner#1708 L9)', () => {
  it('never leaves a clip naming a missing source, and the next edit leaves exactly the referenced sources', () => {
    let run = 0;
    fc.assert(fc.property(fc.array(action, { maxLength: 25 }), fc.boolean(), (steps, finalOnB) => {
      run += 1;
      const names = [`project-p/timeline-sources-a-${run}`, `project-p/timeline-sources-b-${run}`];
      const a = seededDoc(timeline([clip(cid(1), MAIN, 0, 20), clip(cid(2), 'v2', 50, 20, { sourceId: SHORT_SOURCE.id })], undefined, [SOURCE, SHORT_SOURCE]));
      const b = new Y.Doc();
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      const sessions: TimelineEditSession[] = [getTimelineEditSession(a, names[0] ?? ''), getTimelineEditSession(b, names[1] ?? '')];
      let ordinal = 100;
      const next = (): number => { ordinal += 1; return ordinal; };
      try {
        for (const step of steps) {
          const doc = step.replica === 0 ? a : b;
          const session = sessions[step.replica];
          if (session === undefined) continue;
          if (step.kind === 'undo') session.undo();
          else if (step.kind === 'redo') session.redo();
          else {
            const command = commandFor(doc, step.kind === 'untracked-delete' ? { ...step, kind: 'delete' } : step, next);
            if (command !== null) {
              if (step.kind === 'untracked-delete') applyTimelineEdit(doc, command, UNTRACKED);
              else session.edit(command);
            }
          }
          if (step.syncAfter) exchange(a, b);
        }
        exchange(a, b);
        for (const doc of [a, b]) {
          expect(() => readTimelineDocument(doc)).not.toThrow();
          const sources = new Set(stored(doc));
          for (const id of referenced(doc)) expect(sources.has(id), `clip source ${id} is missing`).toBe(true);
        }
        for (const name of ['clips', 'tracks', 'sources']) expect(a.getMap(name).toJSON()).toEqual(b.getMap(name).toJSON());

        const editor = finalOnB ? b : a;
        const final = applyTimelineEdit(editor, {
          operation: 'add_video', parameters: { source: SOURCE, clip: clip(cid(next()), 'v2', 5000, 10) }, placement: { magnet: false, linkage: false },
        }, FINAL);
        expect(final.ok).toBe(true);
        exchange(a, b);
        for (const doc of [a, b]) expect(stored(doc)).toEqual(referenced(doc));
      } finally {
        for (const name of names) evictTimelineEditSession(name);
        a.destroy();
        b.destroy();
      }
    }), { numRuns: 100 });
  });
});
