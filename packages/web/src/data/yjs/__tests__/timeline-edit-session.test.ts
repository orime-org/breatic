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
import { applyTimelineEdit, readTimelineDocument } from '@web/data/yjs/timeline-document';
import type { TimelineEditCommand } from '@web/data/yjs/timeline-edit';

import { _resetForTests, destroyDoc, docName, getDoc } from '@web/data/yjs/manager';
import { evictTimelineEditSession, getTimelineEditSession, type TimelineEditSession } from '@web/data/yjs/timeline-edit-session';
import {
  MAIN, OFF, ON, SOURCE, cid, clip, connect, seededDoc, starts, timeline, track,
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

  it('needs one undo per edit without joinPrevious', () => {
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

  it('merges a joinPrevious edit into the previous step, as a held arrow key does', () => {
    const { mine, session } = pair();
    session.edit(move(X, 11));
    session.edit(move(X, 12), { joinPrevious: true });
    session.edit(move(X, 13), { joinPrevious: true });
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

  it('removes an added clip on undo but keeps its source for other copies', () => {
    const { mine, session } = pair();
    const fresh: TimelineVideoSource = { ...SOURCE, id: '10000000-0000-4000-8000-000000000077', assetId: '20000000-0000-4000-8000-000000000077' };
    const added = clip(cid(40), 'v2', 200, 30, { sourceId: fresh.id });
    expect(session.edit({ operation: 'add_video', parameters: { source: fresh, clip: added }, placement: OFF }).ok).toBe(true);
    session.undo();
    const after = readTimelineDocument(mine);
    expect(after.clips[added.id]).toBe(undefined);
    expect(after.sources[fresh.id]).toEqual(fresh);
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
   * @returns Both replicas and my session.
   * @throws {Error} When seeding fails.
   */
  function apart(clips: ReturnType<typeof clip>[], seededByMe: boolean): { mine: Y.Doc; peer: Y.Doc; session: TimelineEditSession } {
    const seeded = keep(seededDoc(timeline(clips)));
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
    expect(plan.ok && plan.removed).toEqual([COVERED]);
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
});
