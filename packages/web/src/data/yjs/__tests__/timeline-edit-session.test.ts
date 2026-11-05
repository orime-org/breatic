// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Personal undo for Timeline edits (inner#1708 E12, design §3.4, §5.2, §5.4).
 *
 * Two replicas relay every update the way the provider does; the session on one of them must
 * undo only its own edits, one step per edit, and never take back a value the peer wrote later.
 */

import * as React from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { TimelineVideoClipSchema, type TimelineVideoSource } from '@breatic/shared';
import { resolveTimelineArrangement } from '@web/data/yjs/timeline-arrangement';
import { applyTimelineEdit, readTimelineDocument } from '@web/data/yjs/timeline-document';
import type { TimelineEditCommand } from '@web/data/yjs/timeline-edit';

import { _resetForTests, destroyDoc, docName, getDoc } from '@web/data/yjs/manager';
import { evictTimelineEditSession, getTimelineEditSession, type TimelineEditSession } from '@web/data/yjs/timeline-edit-session';
import {
  MAIN, OFF, ON, SHORT_SOURCE, SOURCE, cid, clip, connect, seededDoc, starts, timeline, track,
} from '@web/data/yjs/__tests__/timeline-document-fixtures';

const A = cid(1);
const B = cid(2);
const C = cid(3);
const X = cid(11);
const Z = cid(12);
const MAGNET_OFF_LINKED = { magnet: false, linkage: true } as const;
const NAME = 'project-p/timeline-a';
const PEER_NAME = 'project-p/timeline-b';
const docs: Y.Doc[] = [];
const names = new Set<string>();

/**
 * Track a replica for cleanup.
 * @param doc - The replica.
 * @returns The same replica.
 * @throws {never} Never.
 */
function keep(doc: Y.Doc): Y.Doc {
  docs.push(doc);
  return doc;
}

/**
 * The session for a replica, evicted after the test.
 * @param doc - The replica.
 * @param name - Its document name.
 * @returns The cached session.
 * @throws {never} Never.
 */
function sessionOf(doc: Y.Doc, name = NAME): TimelineEditSession {
  names.add(name);
  return getTimelineEditSession(doc, name);
}

/**
 * Two connected replicas seeded with the same layout.
 * @param clips - The starting clips.
 * @param tracks - The starting tracks.
 * @returns Both replicas and the session on the first.
 * @throws {Error} When seeding fails.
 */
function pair(clips = [clip(A, MAIN, 0, 48), clip(X, 'v2', 10, 20)], tracks = [track(MAIN, 0), track('v2', 1)]): { mine: Y.Doc; peer: Y.Doc; session: TimelineEditSession } {
  const mine = keep(seededDoc(timeline(clips, tracks)));
  const peer = keep(new Y.Doc());
  connect(mine, peer);
  return { mine, peer, session: sessionOf(mine) };
}

/**
 * A move command.
 * @param clipId - The clip.
 * @param startFrame - Its new start.
 * @param placement - The switches.
 * @param target - Optional target track.
 * @returns The command.
 * @throws {never} Never.
 */
function move(clipId: string, startFrame: number, placement = OFF, target: { trackId?: string; newTrackId?: string } = {}): TimelineEditCommand {
  return { operation: 'move', parameters: { clipId, startFrame, ...target }, placement };
}

afterEach(() => {
  for (const name of names) evictTimelineEditSession(name);
  names.clear();
  for (const doc of docs.splice(0)) doc.destroy();
  _resetForTests();
});

describe('Timeline edit session undo steps', () => {
  it('writes each edit under its own origin and starts with empty stacks', () => {
    const { mine, session } = pair();
    expect(session.getSnapshot()).toEqual({ canUndo: false, canRedo: false, selectedClipId: null });
    const origins: unknown[] = [];
    mine.on('afterTransaction', (transaction: Y.Transaction) => { origins.push(transaction.origin); });
    const plan = session.edit(move(X, 40));
    expect(plan.ok).toBe(true);
    expect(origins).toEqual([session.origin]);
    expect(typeof session.origin).toBe('symbol');
    expect(session.getSnapshot()).toEqual({ canUndo: true, canRedo: false, selectedClipId: null });
  });

  it('undoes a magnetic delete and its ripple in one step', () => {
    const { mine, session } = pair([clip(A, MAIN, 0, 48), clip(B, MAIN, 48, 48), clip(C, MAIN, 96, 48)], [track(MAIN, 0)]);
    const before = readTimelineDocument(mine);
    const plan = session.edit({ operation: 'delete', parameters: { clipId: A }, placement: ON });
    expect(plan.ok).toBe(true);
    expect(starts(readTimelineDocument(mine), MAIN)).toEqual([[B, 0, 48], [C, 48, 48]]);
    session.undo();
    expect(readTimelineDocument(mine)).toEqual(before);
    expect(session.getSnapshot().canUndo).toBe(false);
    expect(session.getSnapshot().canRedo).toBe(true);
  });

  it('undoes a linkage shift, the bump and the track it created in one step', () => {
    const { mine, session } = pair([clip(A, MAIN, 0, 48), clip(X, 'v2', 10, 20), clip(Z, 'v2', 100, 20)]);
    const before = readTimelineDocument(mine);
    const plan = session.edit(move(A, 90, MAGNET_OFF_LINKED));
    if (!plan.ok) throw new Error(`Expected an accepted move, got ${plan.reason}`);
    expect(plan.bumped).toEqual([X]);
    const after = readTimelineDocument(mine);
    expect(Object.keys(after.tracks)).toHaveLength(3);
    expect(after.clips[X]?.startFrame).toBe(100);
    session.undo();
    expect(readTimelineDocument(mine)).toEqual(before);
    expect(session.getSnapshot().canUndo).toBe(false);
  });

  it('needs one undo per edit without a hold', () => {
    const { mine, session } = pair();
    session.edit(move(X, 11));
    session.edit(move(X, 12));
    session.undo();
    expect(readTimelineDocument(mine).clips[X]?.startFrame).toBe(11);
    expect(session.getSnapshot().canUndo).toBe(true);
    session.undo();
    expect(readTimelineDocument(mine).clips[X]?.startFrame).toBe(10);
    expect(session.getSnapshot().canUndo).toBe(false);
  });

  it('merges the held edits of a hold into the step that started it, as a held arrow key does (S3, Q1)', () => {
    const { mine, session } = pair();
    session.endHold();
    session.edit(move(X, 11), { hold: true });
    session.edit(move(X, 12), { hold: true });
    session.edit(move(X, 13), { hold: true });
    expect(readTimelineDocument(mine).clips[X]?.startFrame).toBe(13);
    session.undo();
    expect(readTimelineDocument(mine).clips[X]?.startFrame).toBe(10);
    expect(session.getSnapshot().canUndo).toBe(false);
  });

  it('returns a refusal without writing or adding an undo step', () => {
    const { mine, session } = pair();
    const before = Y.encodeStateAsUpdate(mine);
    expect(session.edit(move(cid(99), 4))).toEqual({ ok: false, reason: 'target_missing' });
    expect(Y.encodeStateAsUpdate(mine)).toEqual(before);
    expect(session.getSnapshot().canUndo).toBe(false);
  });

  it('redoes back to exactly the planned document', () => {
    const { mine, session } = pair([clip(A, MAIN, 0, 48), clip(B, MAIN, 48, 48), clip(X, 'v2', 10, 20)]);
    const plan = session.edit({ operation: 'split', parameters: { clipId: A, frame: 20, newClipId: cid(50) }, placement: ON });
    if (!plan.ok) throw new Error(`Expected an accepted split, got ${plan.reason}`);
    session.undo();
    expect(readTimelineDocument(mine).clips[cid(50)]).toBe(undefined);
    session.redo();
    expect(readTimelineDocument(mine)).toEqual(plan.next);
    expect(session.getSnapshot()).toMatchObject({ canUndo: true, canRedo: false });
  });

  it('clears redo when a new edit is committed after an undo', () => {
    const { session } = pair();
    session.edit(move(X, 40));
    session.undo();
    expect(session.getSnapshot().canRedo).toBe(true);
    session.edit(move(X, 50));
    expect(session.getSnapshot()).toMatchObject({ canUndo: true, canRedo: false });
  });

  it('removes an added clip and the source it added on undo (inner#1708 L5)', () => {
    const { mine, session } = pair();
    const fresh: TimelineVideoSource = { ...SOURCE, id: '10000000-0000-4000-8000-000000000077', assetId: '20000000-0000-4000-8000-000000000077' };
    const added = clip(cid(40), 'v2', 200, 30, { sourceId: fresh.id });
    expect(session.edit({ operation: 'add_video', parameters: { source: fresh, clip: added }, placement: OFF }).ok).toBe(true);
    session.undo();
    const after = readTimelineDocument(mine);
    expect(after.clips[added.id]).toBe(undefined);
    expect(after.sources[fresh.id]).toBe(undefined);
  });

  it('keeps a source on undo while another copy still references it (inner#1708 L5)', () => {
    const { mine, session } = pair();
    const fresh: TimelineVideoSource = { ...SOURCE, id: '10000000-0000-4000-8000-000000000078', assetId: '20000000-0000-4000-8000-000000000078' };
    const first = clip(cid(41), 'v2', 200, 30, { sourceId: fresh.id });
    const second = clip(cid(42), 'v2', 300, 30, { sourceId: fresh.id });
    expect(session.edit({ operation: 'add_video', parameters: { source: fresh, clip: first }, placement: OFF }).ok).toBe(true);
    expect(session.edit({ operation: 'add_video', parameters: { source: fresh, clip: second }, placement: OFF }).ok).toBe(true);
    session.undo();
    expect(readTimelineDocument(mine).clips[second.id]).toBe(undefined);
    expect(readTimelineDocument(mine).sources[fresh.id]).toEqual(fresh);
    session.undo();
    expect(readTimelineDocument(mine).clips[first.id]).toBe(undefined);
    expect(readTimelineDocument(mine).sources[fresh.id]).toBe(undefined);
  });

  it('caps the history at 50 steps, dropping the oldest', () => {
    const { mine, session } = pair();
    for (let step = 1; step <= 55; step += 1) session.edit(move(X, 10 + step));
    let undone = 0;
    while (session.getSnapshot().canUndo && undone < 60) {
      session.undo();
      undone += 1;
    }
    expect(undone).toBe(50);
    expect(readTimelineDocument(mine).clips[X]?.startFrame).toBe(15);
  });
});

describe('Timeline edit session with a collaborator', () => {
  it('never undoes the peer\'s edit', () => {
    const { mine, peer, session } = pair();
    session.edit(move(X, 40));
    expect(applyTimelineEdit(peer, move(A, 200), Symbol('peer')).ok).toBe(true);
    session.undo();
    expect(readTimelineDocument(mine).clips[X]?.startFrame).toBe(10);
    expect(readTimelineDocument(mine).clips[A]?.startFrame).toBe(200);
    expect(readTimelineDocument(peer)).toEqual(readTimelineDocument(mine));
    expect(session.getSnapshot().canUndo).toBe(false);
  });

  it('keeps a field the peer wrote after my edit and reverts the field only I wrote', () => {
    const { mine, peer, session } = pair();
    expect(session.edit({ operation: 'set_range', parameters: { clipId: X, startFrame: 10, sourceInFrame: 0, durationFrames: 30 }, placement: OFF }).ok).toBe(true);
    expect(applyTimelineEdit(peer, move(X, 70), Symbol('peer')).ok).toBe(true);
    session.undo();
    expect(readTimelineDocument(mine).clips[X]).toMatchObject({ startFrame: 70, durationFrames: 20 });
  });

  it('keeps the peer\'s later value of the very field I changed', () => {
    const { mine, peer, session } = pair();
    session.edit(move(X, 40));
    expect(applyTimelineEdit(peer, move(X, 70), Symbol('peer')).ok).toBe(true);
    session.undo();
    expect(readTimelineDocument(mine).clips[X]?.startFrame).toBe(70);
  });
});

describe('Timeline edit session selection', () => {
  it('selects an existing clip and clears on null', () => {
    const { session } = pair();
    session.select(X);
    expect(session.getSnapshot().selectedClipId).toBe(X);
    session.select(null);
    expect(session.getSnapshot().selectedClipId).toBe(null);
  });

  it('reads a clip absent from the document as no selection', () => {
    const { session } = pair();
    session.select(cid(99));
    expect(session.getSnapshot().selectedClipId).toBe(null);
  });

  it('clears the selection and notifies when a peer deletes the selected clip', () => {
    const { peer, session } = pair();
    session.select(X);
    const listener = vi.fn();
    const release = session.subscribe(listener);
    expect(applyTimelineEdit(peer, { operation: 'delete', parameters: { clipId: X }, placement: OFF }, Symbol('peer')).ok).toBe(true);
    expect(session.getSnapshot().selectedClipId).toBe(null);
    expect(listener).toHaveBeenCalled();
    release();
  });

  it('clears the selection when my undo removes the selected clip', () => {
    const { session } = pair();
    const added = clip(cid(41), 'v2', 300, 10);
    session.edit({ operation: 'add_video', parameters: { source: SOURCE, clip: added }, placement: OFF });
    session.select(added.id);
    session.undo();
    expect(session.getSnapshot().selectedClipId).toBe(null);
  });

  it('clears the selection when I delete the selected clip', () => {
    const { session } = pair();
    session.select(X);
    session.edit({ operation: 'delete', parameters: { clipId: X }, placement: OFF });
    expect(session.getSnapshot().selectedClipId).toBe(null);
  });
});

describe('Timeline edit session snapshot and subscription', () => {
  it('returns the same snapshot until a fact changes', () => {
    const { peer, session } = pair();
    const first = session.getSnapshot();
    expect(session.getSnapshot()).toBe(first);
    expect(applyTimelineEdit(peer, move(A, 200), Symbol('peer')).ok).toBe(true);
    expect(session.getSnapshot()).toBe(first);
    session.edit(move(X, 40));
    const second = session.getSnapshot();
    expect(second).not.toBe(first);
    expect(session.getSnapshot()).toBe(second);
  });

  it('stops notifying after unsubscribe and tolerates a second release', () => {
    const { session } = pair();
    const listener = vi.fn();
    const release = session.subscribe(listener);
    session.edit(move(X, 40));
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    release();
    release();
    session.edit(move(X, 50));
    session.undo();
    expect(listener).not.toHaveBeenCalled();
  });

  it('drives useSyncExternalStore under StrictMode replay', () => {
    const { session } = pair();
    const { result, unmount } = renderHook(
      () => React.useSyncExternalStore(session.subscribe, session.getSnapshot),
      { wrapper: React.StrictMode },
    );
    expect(result.current.canUndo).toBe(false);
    act(() => { session.edit(move(X, 40)); });
    expect(result.current.canUndo).toBe(true);
    act(() => { session.undo(); });
    expect(result.current).toEqual({ canUndo: false, canRedo: true, selectedClipId: null });
    act(() => { session.select(X); });
    expect(result.current.selectedClipId).toBe(X);
    unmount();
  });
});

describe('Timeline edit session cache', () => {
  it('returns the same session for the same document and name', () => {
    const doc = keep(seededDoc(timeline([clip(X, 'v2', 10, 20)])));
    expect(sessionOf(doc)).toBe(sessionOf(doc));
    expect(sessionOf(doc, PEER_NAME)).not.toBe(sessionOf(doc));
  });

  it('starts a fresh, empty history after eviction', () => {
    const doc = keep(seededDoc(timeline([clip(X, 'v2', 10, 20)])));
    const session = sessionOf(doc);
    session.edit(move(X, 40));
    session.select(X);
    evictTimelineEditSession(NAME);
    const reopened = sessionOf(doc);
    expect(reopened).not.toBe(session);
    expect(reopened.getSnapshot()).toEqual({ canUndo: false, canRedo: false, selectedClipId: null });
    expect(readTimelineDocument(doc).clips[X]?.startFrame).toBe(40);
  });

  it('drops the session when its manager-owned document is destroyed', () => {
    const name = docName.timelineSpace('60000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001');
    const seed = keep(seededDoc(timeline([clip(X, 'v2', 10, 20)])));
    const doc = getDoc(name);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed), 'provider');
    const session = sessionOf(doc, name);
    session.edit(move(X, 40));
    destroyDoc(name);
    expect(doc.isDestroyed).toBe(true);
    const fresh = getDoc(name);
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(seed), 'provider');
    const reopened = sessionOf(fresh, name);
    expect(reopened).not.toBe(session);
    expect(reopened.getSnapshot().canUndo).toBe(false);
    destroyDoc(name);
  });

  it('evicting an unknown name is a no-op', () => {
    expect(() => evictTimelineEditSession('project-p/timeline-never')).not.toThrow();
  });
});

describe('Timeline edit session undo and redo against a concurrent peer (inner#1708 F1a)', () => {
  const MOVED = cid(21);
  const COVERED = cid(22);
  const ADDED = cid(23);

  /**
   * My replica with its session and a peer replica that starts in sync but is not connected. Which replica wrote
   * the seed changes how Yjs restores a deleted record, so every case runs with my session on either one.
   * @param clips - The starting clips.
   * @param seededByMe - Whether my replica wrote the seed, or received it from the peer.
   * @param sources - The stored sources, SOURCE by default.
   * @returns Both replicas and my session.
   * @throws {Error} When seeding fails.
   */
  function apart(clips: ReturnType<typeof clip>[], seededByMe: boolean, sources = [SOURCE]): { mine: Y.Doc; peer: Y.Doc; session: TimelineEditSession } {
    const seeded = keep(seededDoc(timeline(clips, undefined, sources)));
    const copy = keep(new Y.Doc());
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(seeded));
    const mine = seededByMe ? seeded : copy;
    const peer = seededByMe ? copy : seeded;
    return { mine, peer, session: sessionOf(mine) };
  }

  /**
   * Exchange every update between the replicas, as the provider does after a reconnect. Which side receives first
   * changes what my undo restores, so every case runs in both orders.
   * @param mine - My replica.
   * @param peer - The peer replica.
   * @param mineFirst - Whether my replica receives the peer's updates first.
   * @throws {never} Never.
   */
  function sync(mine: Y.Doc, peer: Y.Doc, mineFirst: boolean): void {
    if (mineFirst) Y.applyUpdate(mine, Y.encodeStateAsUpdate(peer), 'remote');
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(mine), 'remote');
    if (!mineFirst) Y.applyUpdate(mine, Y.encodeStateAsUpdate(peer), 'remote');
  }

  const CASES = [
    { seededByMe: true, mineFirst: true }, { seededByMe: true, mineFirst: false },
    { seededByMe: false, mineFirst: true }, { seededByMe: false, mineFirst: false },
  ];

  /**
   * Assert a clip record is present and complete on a replica.
   * @param doc - The replica.
   * @param clipId - The clip.
   * @throws {Error} When the record is missing or incomplete.
   */
  function expectComplete(doc: Y.Doc, clipId: string): void {
    const record = doc.getMap('clips').get(clipId);
    expect(record).toBeInstanceOf(Y.Map);
    const fields = record instanceof Y.Map ? record.toJSON() : null;
    expect(TimelineVideoClipSchema.safeParse(fields).success, `clip ${clipId} is incomplete: ${JSON.stringify(fields)}`).toBe(true);
    expect(() => readTimelineDocument(doc)).not.toThrow();
    expect(readTimelineDocument(doc).clips[clipId]).toMatchObject({ id: clipId, kind: 'video' });
  }

  it.each(CASES)('restores a complete clip when I undo my delete after the peer moved that clip (seeded by me $seededByMe, I receive first $mineFirst)', ({ seededByMe, mineFirst }) => {
    const { mine, peer, session } = apart([clip(A, MAIN, 0, 48), clip(MOVED, 'v2', 0, 48)], seededByMe);
    expect(session.edit({ operation: 'delete', parameters: { clipId: MOVED }, placement: OFF }).ok).toBe(true);
    expect(applyTimelineEdit(peer, move(MOVED, 100), Symbol('peer')).ok).toBe(true);
    sync(mine, peer, mineFirst);
    session.undo();
    sync(mine, peer, mineFirst);
    expectComplete(mine, MOVED);
    expectComplete(peer, MOVED);
  });

  it.each(CASES)('restores a complete overwritten clip when I undo after the peer moved it (seeded by me $seededByMe, I receive first $mineFirst)', ({ seededByMe, mineFirst }) => {
    // Magnet off: my move of B onto frame 0 overwrites and removes COVERED; the peer meanwhile moves COVERED to v2.
    const { mine, peer, session } = apart([clip(COVERED, MAIN, 0, 48), clip(B, MAIN, 48, 48)], seededByMe);
    const plan = session.edit(move(B, 0));
    expect(plan.ok).toBe(true);
    expect(mine.getMap('clips').has(COVERED)).toBe(false);
    expect(applyTimelineEdit(peer, move(COVERED, 0, OFF, { trackId: 'v2' }), Symbol('peer')).ok).toBe(true);
    sync(mine, peer, mineFirst);
    session.undo();
    sync(mine, peer, mineFirst);
    expectComplete(mine, COVERED);
    expectComplete(peer, COVERED);
  });

  it.each(CASES)('redoes a complete clip after the peer edited it before seeing my undo (seeded by me $seededByMe, I receive first $mineFirst)', ({ seededByMe, mineFirst }) => {
    const { mine, peer, session } = apart([clip(A, MAIN, 0, 48)], seededByMe);
    const added: TimelineEditCommand = { operation: 'add_video', parameters: { source: SOURCE, clip: clip(ADDED, 'v2', 200, 48) }, placement: OFF };
    expect(session.edit(added).ok).toBe(true);
    sync(mine, peer, mineFirst);
    session.undo();
    expect(applyTimelineEdit(peer, move(ADDED, 300), Symbol('peer')).ok).toBe(true);
    sync(mine, peer, mineFirst);
    session.redo();
    sync(mine, peer, mineFirst);
    expectComplete(mine, ADDED);
    expectComplete(peer, ADDED);
  });

  const addedOn = (startFrame: number): TimelineEditCommand => ({
    operation: 'add_video', parameters: { source: SOURCE, clip: clip(ADDED, 'v2', startFrame, 48) }, placement: OFF,
  });

  it.each(CASES)('redoes a complete addition after a no-op move that followed it (G1, seeded by me $seededByMe, I receive first $mineFirst)', ({ seededByMe, mineFirst }) => {
    const { mine, peer, session } = apart([clip(A, MAIN, 0, 48)], seededByMe);
    expect(session.edit(addedOn(200)).ok).toBe(true);
    expect(session.edit(move(ADDED, 200)).ok).toBe(true);
    sync(mine, peer, mineFirst);
    session.undo();
    expect(mine.getMap('clips').has(ADDED), 'the undo takes back the addition before the no-op').toBe(false);
    expect(session.getSnapshot()).toMatchObject({ canUndo: false, canRedo: true });
    expect(applyTimelineEdit(peer, move(ADDED, 300), Symbol('peer')).ok).toBe(true);
    sync(mine, peer, mineFirst);
    session.redo();
    sync(mine, peer, mineFirst);
    expectComplete(mine, ADDED);
    expectComplete(peer, ADDED);
  });

  it.each(CASES)('redoes a complete addition after a magnetic main-track move that packed back in place (G1, seeded by me $seededByMe, I receive first $mineFirst)', ({ seededByMe, mineFirst }) => {
    const { mine, peer, session } = apart([clip(A, MAIN, 0, 48), clip(B, MAIN, 48, 48)], seededByMe);
    expect(session.edit(addedOn(200)).ok).toBe(true);
    expect(session.edit(move(B, 60, ON)).ok).toBe(true);
    expect(readTimelineDocument(mine).clips[B]?.startFrame).toBe(48);
    sync(mine, peer, mineFirst);
    session.undo();
    expect(mine.getMap('clips').has(ADDED), 'the undo takes back the addition before the no-op').toBe(false);
    expect(session.getSnapshot()).toMatchObject({ canUndo: false, canRedo: true });
    expect(applyTimelineEdit(peer, move(ADDED, 300), Symbol('peer')).ok).toBe(true);
    sync(mine, peer, mineFirst);
    session.redo();
    sync(mine, peer, mineFirst);
    expectComplete(mine, ADDED);
    expectComplete(peer, ADDED);
  });

  it.each(CASES)('restores a complete clip a later repeat of a held move removed (G1, seeded by me $seededByMe, I receive first $mineFirst)', ({ seededByMe, mineFirst }) => {
    // X[0,10) nudged right to 4 covers Z[12,14) only on the last repeats; the hold is one undo step.
    const { mine, peer, session } = apart([clip(A, MAIN, 0, 48), clip(MOVED, 'v2', 0, 10), clip(COVERED, 'v2', 12, 2, { sourceId: SHORT_SOURCE.id })], seededByMe, [SOURCE, SHORT_SOURCE]);
    session.endHold();
    expect(session.edit(move(MOVED, 1), { hold: true }).ok).toBe(true);
    for (let frame = 2; frame <= 4; frame += 1) expect(session.edit(move(MOVED, frame), { hold: true }).ok).toBe(true);
    expect(mine.getMap('clips').has(COVERED)).toBe(false);
    expect(applyTimelineEdit(peer, move(COVERED, 100), Symbol('peer')).ok).toBe(true);
    sync(mine, peer, mineFirst);
    session.undo();
    sync(mine, peer, mineFirst);
    expect(session.getSnapshot().canUndo).toBe(false);
    expectComplete(mine, COVERED);
    expectComplete(peer, COVERED);
    expect(readTimelineDocument(mine).clips[MOVED]?.startFrame).toBe(0);
  });
});

describe('Timeline edit session undoes and redoes sources with their clips (inner#1708 L5-L8)', () => {
  /** The source X and Y share in these scenarios. */
  const S = SHORT_SOURCE;
  const M = cid(80);
  const XS = cid(81);
  const YS = cid(82);
  const ADDED = cid(83);
  const ELSEWHERE = Symbol('untracked-edit');
  const remove = (clipId: string): TimelineEditCommand => ({ operation: 'delete', parameters: { clipId }, placement: OFF });

  /**
   * Two replicas in sync, each with its own session: a main clip of SOURCE, and X and Y on v2 sharing S.
   * @param tracks - The tracks, main and v2 by default.
   * @returns Both replicas and their sessions.
   * @throws {Error} When seeding fails.
   */
  function shared(tracks = [track(MAIN, 0), track('v2', 1)]): { a: Y.Doc; b: Y.Doc; sessionA: TimelineEditSession; sessionB: TimelineEditSession } {
    const a = keep(seededDoc(timeline([clip(M, MAIN, 0, 48), clip(XS, 'v2', 0, 20, { sourceId: S.id }), clip(YS, 'v2', 100, 20, { sourceId: S.id })], tracks, [SOURCE, S])));
    const b = keep(new Y.Doc());
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    return { a, b, sessionA: sessionOf(a, NAME), sessionB: sessionOf(b, PEER_NAME) };
  }

  /**
   * Exchange every update, the second replica receiving first, as the reference probe does.
   * @param a - One replica.
   * @param b - The other replica.
   * @throws {never} Never.
   */
  function exchange(a: Y.Doc, b: Y.Doc): void {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  }

  /**
   * Whether a replica stores S.
   * @param doc - The replica.
   * @returns True when S is in its sources.
   * @throws {never} Never.
   */
  function holdsS(doc: Y.Doc): boolean {
    return doc.getMap('sources').has(S.id);
  }

  /**
   * Assert a replica reads, holds S unchanged and every clip names a stored source.
   * @param doc - The replica.
   * @param present - Clips that must exist.
   * @param absent - Clips that must not exist.
   * @throws {Error} When a check fails.
   */
  function expectResolved(doc: Y.Doc, present: string[], absent: string[] = []): void {
    expect(() => readTimelineDocument(doc)).not.toThrow();
    const document = readTimelineDocument(doc);
    for (const id of present) expect(document.clips[id], `clip ${id}`).toMatchObject({ id, kind: 'video' });
    for (const id of absent) expect(document.clips[id], `clip ${id}`).toBe(undefined);
    for (const item of Object.values(document.clips)) expect(document.sources[item.sourceId], `source of ${item.id}`).toBeDefined();
    if (present.some((id) => document.clips[id]?.sourceId === S.id)) expect(document.sources[S.id]).toEqual(S);
  }

  /**
   * Assert a session's undo and redo availability.
   * @param session - The session.
   * @param canUndo - Expected undo availability.
   * @param canRedo - Expected redo availability.
   * @throws {Error} When either differs.
   */
  function expectStacks(session: TimelineEditSession, canUndo: boolean, canRedo: boolean): void {
    expect(session.getSnapshot()).toMatchObject({ canUndo, canRedo });
  }

  it('restores the clip and its source on undo and deletes both again on redo (L5)', () => {
    const { a, b, sessionA } = shared();
    expect(applyTimelineEdit(a, remove(YS), ELSEWHERE).ok).toBe(true);
    exchange(a, b);
    expect(sessionA.edit(remove(XS)).ok).toBe(true);
    exchange(a, b);
    expect(holdsS(a)).toBe(false);
    expect(holdsS(b)).toBe(false);
    expectStacks(sessionA, true, false);
    sessionA.undo();
    exchange(a, b);
    for (const doc of [a, b]) expectResolved(doc, [XS]);
    expect(readTimelineDocument(b).sources[S.id]).toEqual(S);
    expectStacks(sessionA, false, true);
    sessionA.redo();
    exchange(a, b);
    for (const doc of [a, b]) { expectResolved(doc, [], [XS]); expect(holdsS(doc)).toBe(false); }
    expectStacks(sessionA, true, false);
    sessionA.undo();
    exchange(a, b);
    for (const doc of [a, b]) expectResolved(doc, [XS]);
    expectStacks(sessionA, false, true);
  });

  it('(a) keeps the source for a clip the peer revives while my edit sweeps it (L6, L8)', () => {
    const { a, b, sessionA, sessionB } = shared();
    expect(sessionB.edit(remove(YS)).ok).toBe(true);
    exchange(a, b);
    sessionB.undo();
    expect(sessionA.edit(remove(XS)).ok).toBe(true);
    expect(holdsS(a), 'my delete of the last clip I see sweeps S').toBe(false);
    exchange(a, b);
    for (const doc of [a, b]) expectResolved(doc, [YS], [XS]);
    expectStacks(sessionA, true, false);
    expectStacks(sessionB, false, true);
    sessionA.undo();
    exchange(a, b);
    for (const doc of [a, b]) expectResolved(doc, [XS, YS]);
    expectStacks(sessionA, false, true);
  });

  it('(b) keeps the source for the peer\'s revived clip when I redo the delete that swept it (L6, L8)', () => {
    const { a, b, sessionA, sessionB } = shared();
    expect(sessionB.edit(remove(YS)).ok).toBe(true);
    exchange(a, b);
    expect(sessionA.edit(remove(XS)).ok).toBe(true);
    expect(holdsS(a)).toBe(false);
    exchange(a, b);
    sessionA.undo();
    exchange(a, b);
    sessionB.undo();
    exchange(a, b);
    sessionA.redo();
    exchange(a, b);
    for (const doc of [a, b]) expectResolved(doc, [YS], [XS]);
    expectStacks(sessionA, true, false);
    expectStacks(sessionB, false, true);
    sessionA.undo();
    exchange(a, b);
    for (const doc of [a, b]) expectResolved(doc, [XS, YS]);
  });

  it('(c) keeps the source when I redo a step that swept it as an orphan after the peer revived a clip (L6, L8)', () => {
    const { a, b, sessionA, sessionB } = shared([track(MAIN, 0), track('v2', 1), track('v3', 2)]);
    expect(applyTimelineEdit(a, remove(XS), ELSEWHERE).ok).toBe(true);
    expect(sessionB.edit(remove(YS)).ok).toBe(true);
    exchange(a, b);
    expect(sessionA.edit({ operation: 'delete_track', parameters: { trackId: 'v3' }, placement: OFF }).ok).toBe(true);
    expect(holdsS(a), 'my unrelated edit sweeps the orphan S').toBe(false);
    exchange(a, b);
    sessionA.undo();
    exchange(a, b);
    sessionB.undo();
    exchange(a, b);
    sessionA.redo();
    exchange(a, b);
    for (const doc of [a, b]) {
      expectResolved(doc, [YS], [XS]);
      expect(readTimelineDocument(doc).tracks.v3).toBe(undefined);
    }
    expectStacks(sessionA, true, false);
    expectStacks(sessionB, false, true);
    sessionA.undo();
    exchange(a, b);
    for (const doc of [a, b]) expect(readTimelineDocument(doc).tracks.v3).toEqual(track('v3', 2));
  });

  it('(d) keeps the source the peer\'s revived clip needs when I undo an addition that re-set it (L6, L8)', () => {
    const { a, b, sessionA, sessionB } = shared();
    expect(applyTimelineEdit(a, remove(XS), ELSEWHERE).ok).toBe(true);
    exchange(a, b);
    expect(sessionB.edit(remove(YS)).ok).toBe(true);
    expect(holdsS(b), 'the peer sweeps S with its last clip').toBe(false);
    exchange(a, b);
    expect(sessionA.edit({ operation: 'add_video', parameters: { source: S, clip: clip(ADDED, 'v2', 300, 20, { sourceId: S.id }) }, placement: OFF }).ok).toBe(true);
    exchange(a, b);
    sessionB.undo();
    exchange(a, b);
    sessionA.undo();
    exchange(a, b);
    for (const doc of [a, b]) expectResolved(doc, [YS], [ADDED, XS]);
    sessionA.redo();
    exchange(a, b);
    for (const doc of [a, b]) expectResolved(doc, [YS, ADDED], [XS]);
    expectStacks(sessionA, true, false);
    expectStacks(sessionB, false, true);
    sessionA.undo();
    exchange(a, b);
    for (const doc of [a, b]) expectResolved(doc, [YS], [ADDED]);
  });

  it('sweeps on redo so sources match the clips, and restores both on the next undo (L7, L8)', () => {
    const { a, b, sessionA } = shared();
    expect(applyTimelineEdit(a, remove(YS), ELSEWHERE).ok).toBe(true);
    exchange(a, b);
    expect(sessionA.edit(remove(XS)).ok).toBe(true);
    exchange(a, b);
    expect(holdsS(a)).toBe(false);
    sessionA.undo();
    exchange(a, b);
    for (const doc of [a, b]) expectResolved(doc, [XS]);
    sessionA.redo();
    exchange(a, b);
    for (const doc of [a, b]) {
      expect(holdsS(doc)).toBe(false);
      expect(Object.keys(readTimelineDocument(doc).sources)).toEqual([SOURCE.id]);
    }
    expectStacks(sessionA, true, false);
    sessionA.undo();
    exchange(a, b);
    for (const doc of [a, b]) expectResolved(doc, [XS]);
    expectStacks(sessionA, false, true);
  });

  it('keeps the source for a clip the peer adds from it while I redo the delete that sweeps it (L7, L8)', () => {
    const { a, b, sessionA, sessionB } = shared();
    expect(applyTimelineEdit(a, remove(YS), ELSEWHERE).ok).toBe(true);
    exchange(a, b);
    expect(sessionA.edit(remove(XS)).ok).toBe(true);
    exchange(a, b);
    expect(holdsS(a)).toBe(false);
    sessionA.undo();
    exchange(a, b);
    sessionA.redo();
    expect(sessionB.edit({ operation: 'add_video', parameters: { source: S, clip: clip(ADDED, 'v2', 300, 20, { sourceId: S.id }) }, placement: OFF }).ok).toBe(true);
    exchange(a, b);
    for (const doc of [a, b]) expectResolved(doc, [ADDED], [XS]);
    expectStacks(sessionA, true, false);
    expectStacks(sessionB, true, false);
    sessionA.undo();
    exchange(a, b);
    for (const doc of [a, b]) expectResolved(doc, [XS, ADDED]);
  });
});

describe('Timeline edit sessions heal dangling sources (inner#1708 H1, H2, H4, H5)', () => {
  const M_CLIP = cid(90);
  const C = cid(91);
  const C2 = cid(92);
  const C3 = cid(93);
  const E = cid(94);
  const SPLIT_X = cid(95);
  const SPLIT_Y = cid(96);
  const remove = (clipId: string): TimelineEditCommand => ({ operation: 'delete', parameters: { clipId }, placement: OFF });
  const splitAt = (clipId: string, frame: number, newClipId: string): TimelineEditCommand => ({ operation: 'split', parameters: { clipId, frame, newClipId }, placement: OFF });
  const ORDERS = [{ first: 1, second: 2 }, { first: 2, second: 1 }];

  /**
   * Wait for any write-back a session schedules after a transaction.
   * @returns Once queued tasks ran.
   * @throws {never} Never.
   */
  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * Two replicas with fixed client ids, loaded from one seed, each with a writable session.
   * @param clips - The seeded clips.
   * @param ids - The client ids of the first and second replica.
   * @param sources - The seeded sources.
   * @returns Both replicas and their sessions.
   * @throws {Error} When seeding fails.
   */
  function writablePair(clips: ReturnType<typeof clip>[], ids: { first: number; second: number }, sources = [SOURCE]): { a: Y.Doc; b: Y.Doc; sa: TimelineEditSession; sb: TimelineEditSession } {
    const seed = keep(seededDoc(timeline(clips, undefined, sources)));
    const a = keep(new Y.Doc());
    a.clientID = ids.first;
    Y.applyUpdate(a, Y.encodeStateAsUpdate(seed), 'remote');
    const b = keep(new Y.Doc());
    b.clientID = ids.second;
    Y.applyUpdate(b, Y.encodeStateAsUpdate(seed), 'remote');
    const sa = sessionOf(a, NAME);
    const sb = sessionOf(b, PEER_NAME);
    sa.setCanWrite(true);
    sb.setCanWrite(true);
    return { a, b, sa, sb };
  }

  /**
   * Exchange updates, let write-backs run and exchange them too.
   * @param a - One replica.
   * @param b - The other replica.
   * @returns Once both replicas settled.
   * @throws {never} Never.
   */
  async function settle(a: Y.Doc, b: Y.Doc): Promise<void> {
    for (let round = 0; round < 3; round += 1) {
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'remote');
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), 'remote');
      await flush();
    }
  }

  /**
   * Assert every clip record names a stored source, the given clips resolve to `value`, and both replicas agree.
   * @param a - One replica.
   * @param b - The other replica.
   * @param present - Clips that must exist and resolve.
   * @param value - The source those clips name.
   * @throws {Error} When a check fails.
   */
  function expectHealed(a: Y.Doc, b: Y.Doc, present: string[], value: TimelineVideoSource): void {
    for (const doc of [a, b]) {
      const sources = doc.getMap('sources');
      for (const [id, record] of doc.getMap('clips').entries()) {
        const sourceId = record instanceof Y.Map ? record.get('sourceId') : undefined;
        if (typeof sourceId === 'string') expect(sources.has(sourceId), `clip ${id} names a missing source`).toBe(true);
      }
      for (const id of present) {
        expect(readTimelineDocument(doc).clips[id]?.sourceId, `clip ${id}`).toBe(value.id);
        expect(sources.get(value.id)).toEqual(value);
      }
    }
    for (const name of ['clips', 'tracks', 'sources']) expect(a.getMap(name).toJSON()).toEqual(b.getMap(name).toJSON());
  }

  it.each(ORDERS)('keeps the source for a part split concurrently while the peer deletes every clip on it (H1 sc6-lww, ids $first/$second)', async (ids) => {
    const { a, b, sa, sb } = writablePair(
      [clip(M_CLIP, MAIN, 0, 48), clip(C, 'v2', 0, 10, { sourceId: SHORT_SOURCE.id }), clip(E, 'v2', 50, 10, { sourceId: SHORT_SOURCE.id })], ids, [SOURCE, SHORT_SOURCE],
    );
    expect(sa.edit(splitAt(C, 5, SPLIT_X)).ok).toBe(true);
    for (const id of [C, SPLIT_X, E]) expect(sa.edit(remove(id)).ok).toBe(true);
    expect(a.getMap('sources').has(SHORT_SOURCE.id)).toBe(false);
    expect(sb.edit(splitAt(E, 55, SPLIT_Y)).ok).toBe(true);
    await settle(a, b);
    expectHealed(a, b, [SPLIT_Y], SHORT_SOURCE);
  });

  it.each(ORDERS)('keeps the source for a clip my undo revives while the peer deletes its other clip (H1 different-clips, ids $first/$second)', async (ids) => {
    const { a, b, sa, sb } = writablePair([clip(C, 'v2', 0, 48), clip(E, 'v2', 100, 48)], ids);
    expect(sa.edit(remove(E)).ok).toBe(true);
    await settle(a, b);
    expect(sb.edit(move(C, 10)).ok).toBe(true);
    sb.undo();
    expect(sb.edit(remove(C)).ok).toBe(true);
    sa.undo();
    await settle(a, b);
    expectHealed(a, b, [E], SOURCE);
  });

  it.each(ORDERS)('keeps the source for a duplicate made while the peer splits and deletes the original (H1 goal-e5-race, ids $first/$second)', async (ids) => {
    const { a, b, sa, sb } = writablePair([clip(C, 'v2', 0, 48)], ids);
    expect(sb.edit(splitAt(C, 20, C2)).ok).toBe(true);
    expect(sb.edit(remove(C2)).ok).toBe(true);
    expect(sb.edit(remove(C)).ok).toBe(true);
    expect(sa.edit({ operation: 'duplicate', parameters: { clipId: C, newClipId: C3 }, placement: OFF }).ok).toBe(true);
    await settle(a, b);
    expectHealed(a, b, [C3], SOURCE);
  });

  it('writes a remembered source back after a remote update removes it under a clip, outside the undo history (H1)', async () => {
    const { a, b, sa } = writablePair([clip(C, 'v2', 0, 48)], ORDERS[0] ?? { first: 1, second: 2 });
    b.transact(() => b.getMap('sources').delete(SOURCE.id), 'peer');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), 'remote');
    await flush();
    expect(a.getMap('sources').get(SOURCE.id)).toEqual(SOURCE);
    expect(sa.getSnapshot()).toMatchObject({ canUndo: false, canRedo: false });
  });

  it.each([['never made writable', false], ['made read-only again', true]] as const)('never writes from a session %s, even over a dangling source (H2)', async (_name, toggled) => {
    const seed = keep(seededDoc(timeline([clip(C, 'v2', 0, 48)])));
    const viewer = keep(new Y.Doc());
    Y.applyUpdate(viewer, Y.encodeStateAsUpdate(seed), 'remote');
    const session = sessionOf(viewer, PEER_NAME);
    if (toggled) {
      session.setCanWrite(true);
      session.setCanWrite(false);
    }
    let ownUpdates = 0;
    viewer.on('update', (_update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => { if (transaction.local) ownUpdates += 1; });
    seed.transact(() => seed.getMap('sources').delete(SOURCE.id), 'peer');
    Y.applyUpdate(viewer, Y.encodeStateAsUpdate(seed, Y.encodeStateVector(viewer)), 'remote');
    await flush();
    expect(viewer.getMap('sources').has(SOURCE.id)).toBe(false);
    expect(ownUpdates).toBe(0);
  });

  it('undoes and redoes a plain move without writing sources (H4)', () => {
    const { mine, session } = pair();
    expect(session.edit(move(X, 40)).ok).toBe(true);
    let writes = 0;
    mine.getMap('sources').observe(() => { writes += 1; });
    session.undo();
    expect(readTimelineDocument(mine).clips[X]?.startFrame).toBe(10);
    session.redo();
    expect(readTimelineDocument(mine).clips[X]?.startFrame).toBe(40);
    expect(writes).toBe(0);
  });

  it('adds no undo step for a no-op edit while an orphan source is present (H5)', () => {
    // My real edit deletes C; the peer deletes E, the other clip on SOURCE, leaving SOURCE unreferenced here.
    const seeded = keep(seededDoc(timeline([clip(M_CLIP, 'v2', 0, 10, { sourceId: SHORT_SOURCE.id }), clip(C, 'v2', 100, 10), clip(E, 'v2', 200, 10)], undefined, [SOURCE, SHORT_SOURCE])));
    const peer = keep(new Y.Doc());
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(seeded));
    const session = sessionOf(seeded);
    expect(session.edit(remove(C)).ok).toBe(true);
    expect(applyTimelineEdit(peer, remove(E), Symbol('peer')).ok).toBe(true);
    Y.applyUpdate(seeded, Y.encodeStateAsUpdate(peer), 'remote');
    expect(seeded.getMap('sources').has(SOURCE.id)).toBe(true);
    let updates = 0;
    seeded.on('update', () => { updates += 1; });
    expect(session.edit(move(M_CLIP, 0)).ok).toBe(true);
    expect(updates).toBe(0);
    session.undo();
    expect(readTimelineDocument(seeded).clips[C]).toMatchObject({ id: C, sourceId: SOURCE.id });
    expect(readTimelineDocument(seeded).sources[SOURCE.id]).toEqual(SOURCE);
    expect(session.getSnapshot().canUndo).toBe(false);
  });
});

describe('Timeline edit session ignores a no-op on a clip that is not the last key (inner#1708 N1)', () => {
  it('undoes the real edit in one step after a no-op move with an orphan source present', () => {
    const FIRST = cid(101);
    const SECOND = cid(102);
    const doc = keep(seededDoc(timeline([clip(FIRST, 'v2', 0, 10), clip(SECOND, 'v2', 40, 10)], undefined, [SOURCE])));
    const session = sessionOf(doc);
    session.setCanWrite(true);
    expect(session.edit(move(SECOND, 60)).ok).toBe(true);
    doc.transact(() => doc.getMap('sources').set(SHORT_SOURCE.id, SHORT_SOURCE), 'remote');
    expect(session.edit(move(FIRST, 0)).ok).toBe(true);
    expect(doc.getMap('sources').has(SHORT_SOURCE.id)).toBe(true);
    session.undo();
    expect(readTimelineDocument(doc).clips[SECOND]?.startFrame).toBe(40);
    expect(session.getSnapshot().canUndo).toBe(false);
  });
});

describe('Timeline edit session refuses a nudge past the largest safe frame (inner#1708 P3)', () => {
  it('returns invalid_range instead of throwing and adds no undo step', () => {
    const near = Number.MAX_SAFE_INTEGER - 10;
    const doc = keep(seededDoc(timeline([clip(X, 'v2', 0, 10)])));
    const session = sessionOf(doc);
    expect(session.edit(move(X, near)).ok).toBe(true);
    let result: ReturnType<TimelineEditSession['edit']> | undefined;
    expect(() => { result = session.edit(move(X, near + 24)); }).not.toThrow();
    expect(result).toEqual({ ok: false, reason: 'invalid_range' });
    expect(readTimelineDocument(doc).clips[X]?.startFrame).toBe(near);
    session.undo();
    expect(session.getSnapshot().canUndo).toBe(false);
  });
});

describe('Timeline edit session joins a key hold only to its own step (inner#1708 S3)', () => {
  const OTHER = cid(110);
  const fresh = (): ReturnType<typeof pair> => pair([clip(X, 'v2', 0, 20), clip(OTHER, 'v2', 100, 20)]);

  it('does not join a continued hold to an unrelated earlier step', () => {
    const { mine, session } = fresh();
    expect(session.edit({ operation: 'delete', parameters: { clipId: OTHER }, placement: OFF }).ok).toBe(true);
    expect(session.edit(move(X, 1), { hold: true }).ok).toBe(true);
    expect(session.edit(move(X, 2), { hold: true }).ok).toBe(true);
    session.undo();
    expect(readTimelineDocument(mine).clips[X]?.startFrame).toBe(0);
    expect(readTimelineDocument(mine).clips[OTHER]).toBe(undefined);
    expect(session.getSnapshot().canUndo).toBe(true);
  });

  it('undoes a started hold and its continuations in one step', () => {
    const { mine, session } = fresh();
    session.endHold();
    expect(session.edit(move(X, 1), { hold: true }).ok).toBe(true);
    for (let frame = 2; frame <= 4; frame += 1) expect(session.edit(move(X, frame), { hold: true }).ok).toBe(true);
    session.undo();
    expect(readTimelineDocument(mine).clips[X]?.startFrame).toBe(0);
    expect(session.getSnapshot().canUndo).toBe(false);
  });

  it('joins continuations only to each other when the start was refused', () => {
    const { mine, session } = fresh();
    expect(session.edit(move(X, 5)).ok).toBe(true);
    session.endHold();
    expect(session.edit(move(cid(111), 1), { hold: true })).toEqual({ ok: false, reason: 'target_missing' });
    expect(session.edit(move(X, 6), { hold: true }).ok).toBe(true);
    expect(session.edit(move(X, 7), { hold: true }).ok).toBe(true);
    session.undo();
    expect(readTimelineDocument(mine).clips[X]?.startFrame).toBe(5);
    session.undo();
    expect(readTimelineDocument(mine).clips[X]?.startFrame).toBe(0);
    expect(session.getSnapshot().canUndo).toBe(false);
  });

  it('starts a new step when an edit without a hold came between', () => {
    const { mine, session } = fresh();
    session.endHold();
    expect(session.edit(move(X, 1), { hold: true }).ok).toBe(true);
    expect(session.edit(move(OTHER, 150)).ok).toBe(true);
    expect(session.edit(move(X, 2), { hold: true }).ok).toBe(true);
    session.undo();
    expect(readTimelineDocument(mine).clips[X]?.startFrame).toBe(1);
    expect(readTimelineDocument(mine).clips[OTHER]?.startFrame).toBe(150);
  });

  it('starts a new step when an undo came between', () => {
    const { mine, session } = fresh();
    expect(session.edit(move(OTHER, 150)).ok).toBe(true);
    session.endHold();
    expect(session.edit(move(X, 1), { hold: true }).ok).toBe(true);
    session.undo();
    expect(session.edit(move(X, 2), { hold: true }).ok).toBe(true);
    session.undo();
    expect(readTimelineDocument(mine).clips[X]?.startFrame).toBe(0);
    expect(readTimelineDocument(mine).clips[OTHER]?.startFrame).toBe(150);
  });
});

describe('Timeline edit session ends a hold on request and on selection (inner#1708 T1)', () => {
  const OTHER = cid(130);
  const fresh = (): ReturnType<typeof pair> => pair([clip(X, 'v2', 0, 20), clip(OTHER, 'v2', 100, 20)]);

  it('starts a new step for a held edit after endHold', () => {
    const { mine, session } = fresh();
    session.endHold();
    expect(session.edit(move(X, 1), { hold: true }).ok).toBe(true);
    expect(session.edit(move(X, 2), { hold: true }).ok).toBe(true);
    session.endHold();
    expect(session.edit(move(X, 3), { hold: true }).ok).toBe(true);
    session.undo();
    expect(readTimelineDocument(mine).clips[X]?.startFrame).toBe(2);
    session.undo();
    expect(readTimelineDocument(mine).clips[X]?.startFrame).toBe(0);
    expect(session.getSnapshot().canUndo).toBe(false);
  });

  it('starts a new step for a held edit after the selection changed', () => {
    const { mine, session } = fresh();
    session.endHold();
    expect(session.edit(move(X, 1), { hold: true }).ok).toBe(true);
    expect(session.edit(move(X, 2), { hold: true }).ok).toBe(true);
    session.select(OTHER);
    expect(session.edit(move(OTHER, 101), { hold: true }).ok).toBe(true);
    session.undo();
    expect(readTimelineDocument(mine).clips[OTHER]?.startFrame).toBe(100);
    expect(readTimelineDocument(mine).clips[X]?.startFrame).toBe(2);
    expect(session.getSnapshot().canUndo).toBe(true);
  });
});

describe('Timeline edit session with records naming Object.prototype keys (inner#1708 R2)', () => {
  const ODD = cid(150);
  const NAMES = ['constructor', 'toString', 'hasOwnProperty', '__proto__'] as const;

  /**
   * Write a complete clip record whose source id is an Object.prototype key, as a peer could.
   * @param doc - The peer replica.
   * @param name - The source id.
   * @throws {Error} When Yjs cannot attach the map.
   */
  function writeOdd(doc: Y.Doc, name: string): void {
    doc.transact(() => {
      const record = new Y.Map<unknown>();
      doc.getMap('clips').set(ODD, record);
      for (const [key, value] of Object.entries(clip(ODD, 'v2', 100, 5, { sourceId: name }))) record.set(key, value);
    }, 'peer');
  }

  it.each(NAMES)('applies a peer record naming %s without throwing and keeps both replicas in sync', (name) => {
    const { mine, peer, session } = pair();
    session.setCanWrite(true);
    expect(() => writeOdd(peer, name)).not.toThrow();
    expect(mine.getMap('clips').has(ODD)).toBe(true);
    expect(session.edit(move(X, 30)).ok).toBe(true);
    expect((peer.getMap('clips').get(X) as Y.Map<unknown> | undefined)?.get('startFrame')).toBe(30);
    for (const name2 of ['clips', 'tracks', 'sources']) expect(mine.getMap(name2).toJSON()).toEqual(peer.getMap(name2).toJSON());
  });

  it('keeps restoring a real missing source after a peer stores sources.__proto__, and writes nothing for constructor', async () => {
    const { mine, peer, session } = pair();
    session.setCanWrite(true);
    writeOdd(peer, 'constructor');
    peer.transact(() => peer.getMap('sources').set('__proto__', { injected: true }), 'peer');
    peer.transact(() => peer.getMap('sources').delete(SOURCE.id), 'peer');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mine.getMap('sources').get(SOURCE.id)).toEqual(SOURCE);
    expect(mine.getMap('sources').has('constructor')).toBe(false);
    expect(peer.getMap('sources').get(SOURCE.id)).toEqual(SOURCE);
  });
});

describe('Timeline edit session with a source stored in an unexpected form (inner#1708 S1)', () => {
  const C = cid(160);
  const C2 = cid(161);
  const C3 = cid(162);
  const ODD_SOURCE = '10000000-0000-4000-8000-0000000000aa';

  /**
   * Wait for any write-back a session schedules after a transaction.
   * @returns Once queued tasks ran.
   * @throws {never} Never.
   */
  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * Rewrite SOURCE as a Y.Map holding the same fields, as a peer could.
   * @param doc - The writing replica.
   * @throws {Error} When Yjs cannot attach the map.
   */
  function sourceAsMap(doc: Y.Doc): void {
    doc.transact(() => {
      const record = new Y.Map<unknown>();
      doc.getMap('sources').set(SOURCE.id, record);
      for (const [key, value] of Object.entries(SOURCE)) record.set(key, value);
    }, 'peer');
  }

  /**
   * Count the updates a replica emits from its own transactions.
   * @param doc - The replica.
   * @returns A reader of the live count.
   * @throws {never} Never.
   */
  function ownUpdates(doc: Y.Doc): () => number {
    let count = 0;
    doc.on('update', (_update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => { if (transaction.local) count += 1; });
    return () => count;
  }

  it('restores a Y.Map source a peer deletes as a plain value and keeps syncing (a)', async () => {
    const { mine, peer, session } = pair([clip(C, MAIN, 0, 20)]);
    session.setCanWrite(true);
    expect(() => sourceAsMap(peer)).not.toThrow();
    expect(() => peer.transact(() => peer.getMap('sources').delete(SOURCE.id), 'peer')).not.toThrow();
    await flush();
    const restored = mine.getMap('sources').get(SOURCE.id);
    expect(restored).not.toBeInstanceOf(Y.Map);
    expect(restored).toEqual(SOURCE);
    expect(peer.getMap('sources').get(SOURCE.id)).toEqual(SOURCE);
    const sent = ownUpdates(mine);
    expect(() => session.edit(move(C, 30))).not.toThrow();
    expect(sent()).toBeGreaterThan(0);
    expect((peer.getMap('clips').get(C) as Y.Map<unknown> | undefined)?.get('startFrame')).toBe(30);
  });

  it('undoes deleting the last clip of a Y.Map source and keeps editing (b)', () => {
    const doc = keep(seededDoc(timeline([clip(C, MAIN, 0, 20)])));
    sourceAsMap(doc);
    const session = sessionOf(doc);
    session.setCanWrite(true);
    expect(session.edit({ operation: 'delete', parameters: { clipId: C }, placement: OFF }).ok).toBe(true);
    expect(() => session.undo()).not.toThrow();
    expect(doc.getMap('clips').has(C)).toBe(true);
    expect(readTimelineDocument(doc).sources[SOURCE.id]).toEqual(SOURCE);
    const sent = ownUpdates(doc);
    let plan: ReturnType<TimelineEditSession['edit']> | undefined;
    expect(() => { plan = session.edit(move(C, 30)); }).not.toThrow();
    expect(plan?.ok).toBe(true);
    expect(sent()).toBeGreaterThan(0);
  });

  it.each([
    ['a record missing required fields', { id: ODD_SOURCE }],
    ['a number', 42],
  ] as const)('writes nothing back for a source stored as %s, and still restores a real one (c)', async (_name, odd) => {
    const { mine, peer, session } = pair([clip(C2, 'v2', 0, 10, { sourceId: ODD_SOURCE }), clip(C3, 'v2', 50, 10, { sourceId: SHORT_SOURCE.id })]);
    peer.transact(() => peer.getMap('sources').set(SHORT_SOURCE.id, SHORT_SOURCE), 'peer');
    session.setCanWrite(true);
    expect(() => peer.transact(() => peer.getMap('sources').set(ODD_SOURCE, odd), 'peer')).not.toThrow();
    expect(() => peer.transact(() => {
      peer.getMap('sources').delete(ODD_SOURCE);
      peer.getMap('sources').delete(SHORT_SOURCE.id);
    }, 'peer')).not.toThrow();
    await flush();
    expect(mine.getMap('sources').has(ODD_SOURCE)).toBe(false);
    expect(mine.getMap('sources').get(SHORT_SOURCE.id)).toEqual(SHORT_SOURCE);
    const reasons = resolveTimelineArrangement(readTimelineDocument(mine)).conflicts.find((item) => item.clipId === C2)?.reasons.map((reason) => reason.code);
    expect(reasons).toContain('missing_source');
  });

  it('never writes or throws from a viewer session (d)', async () => {
    const { mine, peer } = pair([clip(C, MAIN, 0, 20)]);
    const sent = ownUpdates(mine);
    expect(() => sourceAsMap(peer)).not.toThrow();
    expect(() => peer.transact(() => peer.getMap('sources').delete(SOURCE.id), 'peer')).not.toThrow();
    await flush();
    expect(mine.getMap('sources').has(SOURCE.id)).toBe(false);
    expect(sent()).toBe(0);
  });
});

describe('Timeline edit session never caches a source stored under another key (inner#1708 F1)', () => {
  it('writes nothing back for a referenced key whose value names another id', async () => {
    const KEY = '10000000-0000-4000-8000-0000000000c1';
    const C = cid(180);
    const { mine, peer, session } = pair([clip(C, 'v2', 0, 10, { sourceId: KEY })]);
    session.setCanWrite(true);
    peer.transact(() => peer.getMap('sources').set(KEY, { ...SOURCE, id: '10000000-0000-4000-8000-0000000000c2' }), 'peer');
    peer.transact(() => peer.getMap('sources').delete(KEY), 'peer');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mine.getMap('sources').has(KEY)).toBe(false);
    expect(peer.getMap('sources').has(KEY)).toBe(false);
  });
});
