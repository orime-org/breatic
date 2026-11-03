// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Sources follow the clips across collaborating sessions (inner#1708 L9, H3, design §3.4, §3.6).
 *
 * Replicas, each with its own writable edit session, run a random sequence of additions, splits, duplicates,
 * deletes, moves (some held), undos and redos with random partial syncs. After the final syncs no clip may name a
 * missing source or lack a field and all replicas are equal; after one more edit the stored sources are exactly
 * the ones the clips reference.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import { TimelineVideoClipSchema, type TimelineVideoSource } from '@breatic/shared';

import { _resetForTests } from '@web/data/yjs/manager';
import { applyTimelineEdit, readTimelineDocument } from '@web/data/yjs/timeline-document';
import type { TimelineEditCommand } from '@web/data/yjs/timeline-edit';
import { evictTimelineEditSession, getTimelineEditSession, type TimelineEditSession } from '@web/data/yjs/timeline-edit-session';
import { MAIN, SHORT_SOURCE, SOURCE, cid, clip, seededDoc, timeline } from '@web/data/yjs/__tests__/timeline-document-fixtures';

const FINAL = Symbol('final-edit');
const UNTRACKED = Symbol('untracked-edit');
const ACTIONS = ['add', 'split', 'duplicate', 'delete', 'move', 'undo', 'redo', 'untracked-delete'] as const;

const action = fc.record({
  replica: fc.integer({ min: 0, max: 2 }),
  kind: fc.constantFrom(...ACTIONS),
  pick: fc.nat(),
  sourcePick: fc.integer({ min: 0, max: 2 }),
  frame: fc.integer({ min: 0, max: 400 }),
  length: fc.integer({ min: 1, max: 30 }),
  onMain: fc.boolean(),
  magnet: fc.boolean(),
  syncAfter: fc.boolean(),
  join: fc.boolean(),
  syncWith: fc.integer({ min: 0, max: 2 }),
});
type Action = typeof action extends fc.Arbitrary<infer T> ? T : never;

afterEach(() => {
  _resetForTests();
});

/**
 * Exchange the updates each replica lacks.
 * @param a - One replica.
 * @param b - The other replica.
 * @throws {never} Never.
 */
function exchange(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'remote');
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), 'remote');
}

/**
 * Wait for any write-back a session schedules after a transaction.
 * @returns Once queued tasks ran.
 * @throws {never} Never.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Sync every pair of replicas and let write-backs run, until a round produces no new update (at most five rounds).
 * @param docs - The replicas.
 * @returns Once the replicas settled.
 * @throws {never} Never.
 */
async function settleAll(docs: readonly Y.Doc[]): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    const before = docs.map((doc) => Y.encodeStateVector(doc).join(','));
    for (const left of docs) for (const right of docs) if (left !== right) exchange(left, right);
    await flush();
    if (docs.every((doc, index) => Y.encodeStateVector(doc).join(',') === before[index])) return;
  }
}

/**
 * A replica's clips, tracks and sources as JSON with sorted keys, for comparing replicas.
 * @param doc - The replica.
 * @returns The normalized content.
 * @throws {never} Never.
 */
function normalized(doc: Y.Doc): string {
  const canon = (value: unknown): unknown => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canon(Reflect.get(value, key))]))
    : value;
  return JSON.stringify(canon({ clips: doc.getMap('clips').toJSON(), tracks: doc.getMap('tracks').toJSON(), sources: doc.getMap('sources').toJSON() }));
}

/**
 * Run random actions on replicas that each hold a writable session.
 * @param docs - The replicas.
 * @param sessions - Their sessions.
 * @param steps - The actions.
 * @param next - Supplies new ordinals.
 * @returns Once every action ran.
 * @throws {Error} When an edit throws.
 */
async function play(docs: readonly Y.Doc[], sessions: readonly TimelineEditSession[], steps: readonly Action[], next: () => number): Promise<void> {
  for (const step of steps) {
    const index = step.replica % docs.length;
    const doc = docs[index];
    const session = sessions[index];
    if (doc === undefined || session === undefined) continue;
    if (step.kind === 'undo') session.undo();
    else if (step.kind === 'redo') session.redo();
    else {
      const command = commandFor(doc, step.kind === 'untracked-delete' ? { ...step, kind: 'delete' } : step, next);
      if (command !== null) {
        if (step.kind === 'untracked-delete') applyTimelineEdit(doc, command, UNTRACKED);
        else session.edit(command, step.kind === 'move' ? { hold: step.join ? 'continue' as const : 'start' as const } : {});
      }
    }
    if (step.syncAfter) {
      const other = docs[step.syncWith % docs.length];
      if (other !== undefined && other !== doc) exchange(doc, other);
      await flush();
    }
  }
}

/**
 * Seeded replicas loaded from one document, each with a writable session.
 * @param count - How many replicas.
 * @param run - The run number, for unique session names.
 * @returns The replicas, their sessions and session names.
 * @throws {Error} When seeding fails.
 */
function replicas(count: number, run: number): { docs: Y.Doc[]; sessions: TimelineEditSession[]; names: string[] } {
  const seed = seededDoc(timeline([clip(cid(1), MAIN, 0, 20), clip(cid(2), 'v2', 50, 20, { sourceId: SHORT_SOURCE.id })], undefined, [SOURCE, SHORT_SOURCE]));
  const docs = [seed];
  for (let index = 1; index < count; index += 1) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
    docs.push(doc);
  }
  const names = docs.map((_doc, index) => `project-p/timeline-sources-${count}-${run}-${index}`);
  const sessions = docs.map((doc, index) => getTimelineEditSession(doc, names[index] ?? ''));
  for (const session of sessions) session.setCanWrite(true);
  return { docs, sessions, names };
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
  it('never leaves a clip naming a missing source, and the next edit leaves exactly the referenced sources', async () => {
    let run = 0;
    await fc.assert(fc.asyncProperty(fc.array(action, { maxLength: 25 }), fc.boolean(), async (steps, finalOnB) => {
      run += 1;
      const { docs, sessions, names } = replicas(2, run);
      const [a, b] = docs;
      if (a === undefined || b === undefined) throw new Error('Two replicas expected');
      let ordinal = 100;
      const next = (): number => { ordinal += 1; return ordinal; };
      try {
        await play(docs, sessions, steps.map((step) => ({ ...step, replica: step.replica % 2 })), next);
        await settleAll(docs);
        for (const doc of docs) {
          expect(() => readTimelineDocument(doc)).not.toThrow();
          const sources = new Set(stored(doc));
          for (const id of referenced(doc)) expect(sources.has(id), `clip source ${id} is missing`).toBe(true);
        }
        expect(normalized(a)).toBe(normalized(b));

        const final = applyTimelineEdit(finalOnB ? b : a, {
          operation: 'add_video', parameters: { source: SOURCE, clip: clip(cid(next()), 'v2', 5000, 10) }, placement: { magnet: false, linkage: false },
        }, FINAL);
        expect(final.ok).toBe(true);
        await settleAll(docs);
        for (const doc of docs) expect(stored(doc)).toEqual(referenced(doc));
      } finally {
        for (const name of names) evictTimelineEditSession(name);
        for (const doc of docs) doc.destroy();
      }
    }), { numRuns: 100 });
  }, 60_000);
});

describe('Timeline sources across three collaborating writable sessions (inner#1708 H3)', () => {
  it('leaves every clip complete and naming a stored source, and every replica equal, after the final syncs', async () => {
    let run = 0;
    await fc.assert(fc.asyncProperty(fc.array(action, { minLength: 20, maxLength: 40 }), async (steps) => {
      run += 1;
      const { docs, sessions, names } = replicas(3, run);
      let ordinal = 100;
      const next = (): number => { ordinal += 1; return ordinal; };
      try {
        await play(docs, sessions, steps, next);
        await settleAll(docs);
        for (const doc of docs) {
          const sources = new Set(stored(doc));
          for (const [id, record] of doc.getMap('clips').entries()) {
            const fields: unknown = record instanceof Y.Map ? record.toJSON() : record;
            expect(TimelineVideoClipSchema.safeParse(fields).success, `clip ${id} is incomplete: ${JSON.stringify(fields)}`).toBe(true);
          }
          for (const id of referenced(doc)) expect(sources.has(id), `clip source ${id} is missing`).toBe(true);
        }
        const first = docs[0];
        if (first === undefined) throw new Error('Three replicas expected');
        for (const doc of docs) expect(normalized(doc)).toBe(normalized(first));
      } finally {
        for (const name of names) evictTimelineEditSession(name);
        for (const doc of docs) doc.destroy();
      }
    }), { numRuns: 200 });
  }, 60_000);
});
