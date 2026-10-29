// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import {
  SceneSession,
  type SceneEnvironment,
} from '@web/data/yjs/scene-session';
import { destroyDoc } from '@web/data/yjs/manager';
import { applySceneCommand, readSceneDocument } from '@web/data/yjs/scene-document';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MISSING = '33333333-3333-4333-8333-333333333333';
const NAME = `project-${ID}/3d-${OTHER}`;
const OBJECT = { id: ID, name: 'Figure', model: { kind: 'builtin' as const, id: 'figure' as const },
  position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number], locked: false, exists: true };
const EDITOR: SceneEnvironment = { readOnly: false, connected: true, hasEverSynced: true,
  writeAccess: 'granted', refused: false, awareness: null };
const managed: { session: SceneSession; doc: Y.Doc; name: string }[] = [];
const awarenessInstances: Awareness[] = [];
const peerDocs: Y.Doc[] = [];

/** Create a live in-memory owner for shared scene content. */
function fixture(name = NAME): { session: SceneSession; doc: Y.Doc } {
  const doc = new Y.Doc();
  doc.getMap('scene').set('formatVersion', 1);
  applySceneCommand(doc, { type: 'create', objects: [OBJECT] }, Symbol(), true);
  const session = new SceneSession(doc);
  managed.push({ session, doc, name });
  session.setEnvironment(EDITOR);
  return { session, doc };
}

/** Track real awareness resources and initialize the authenticated local identity. */
function presence(doc: Y.Doc, userId: string): Awareness {
  const awareness = new Awareness(doc); awarenessInstances.push(awareness);
  awareness.setLocalState({ user: { id: userId } });
  return awareness;
}

/** Deliver a real protocol update from an independently owned peer awareness instance. */
function publishPeer(local: Awareness, userId: string, scenePresence?: unknown): Awareness {
  const doc = new Y.Doc(); peerDocs.push(doc);
  const remote = presence(doc, userId);
  remote.setLocalState({ user: { id: userId }, ...(scenePresence === undefined ? {} : { scenePresence }) });
  applyAwarenessUpdate(local, encodeAwarenessUpdate(remote, [remote.clientID]), 'remote');
  return remote;
}

beforeEach(() => { vi.stubGlobal('indexedDB', undefined); });
afterEach(() => {
  for (const { session } of managed) session.destroy();
  for (const awareness of awarenessInstances.splice(0)) awareness.destroy();
  for (const { doc, name } of managed.splice(0)) { destroyDoc(name, doc); if (!doc.isDestroyed) doc.destroy(); }
  for (const doc of peerDocs.splice(0)) doc.destroy();
});

describe('scene session invariants (inner#1685 acceptance 5/6/8/9/10/11/14)', () => {
  it.each([
    { readOnly: true, writeAccess: 'granted' as const, refused: false, allowed: false },
    { readOnly: false, writeAccess: 'denied' as const, refused: false, allowed: false },
    { readOnly: false, writeAccess: 'denied' as const, refused: true, allowed: true },
    { readOnly: false, writeAccess: 'granted' as const, refused: false, allowed: true },
    { readOnly: false, writeAccess: 'unknown' as const, refused: false, allowed: true },
  ])('keeps role and connection permission distinct for $writeAccess, readOnly=$readOnly, refused=$refused', ({ allowed, ...facts }) => {
    const { session, doc } = fixture();
    session.setEnvironment({ ...EDITOR, ...facts, connected: false });
    session.select(ID, false);
    expect(session.getSnapshot().selectedIds).toEqual([ID]);
    expect(session.getSnapshot().canEdit).toBe(allowed);
    expect(session.execute({ type: 'patch', patches: [{ id: ID, name: 'Local edit' }] })).toEqual(
      allowed ? { ok: true, ids: [ID] } : { ok: false, reason: 'readOnly' },
    );
    expect(readSceneDocument(doc).objects[0]?.name).toBe(allowed ? 'Local edit' : 'Figure');
    expect(session.getSnapshot().commandError).toEqual(allowed ? null : { ok: false, reason: 'readOnly' });
    session.setEnvironment(EDITOR);
    expect(session.execute({ type: 'patch', patches: [{ id: ID, name: 'Allowed again' }] })).toEqual({ ok: true, ids: [ID] });
    expect(session.getSnapshot().commandError).toBeNull();
  });

  it('makes generated Shift-selection sequences personal and never writes scene content or history', () => {
    const { session, doc } = fixture();
    applySceneCommand(doc, { type: 'create', objects: [{ ...OBJECT, id: OTHER }] }, Symbol(), true);
    const bytes = Y.encodeStateAsUpdate(doc);
    fc.assert(fc.property(fc.array(fc.constantFrom(ID, OTHER, null), { minLength: 1, maxLength: 40 }), (targets) => {
      session.select(null, false); const expected = new Set<string>();
      for (const target of targets) {
        if (target === null) expected.clear();
        else if (expected.has(target)) expected.delete(target); else expected.add(target);
        session.select(target, true);
        expect([...session.getSnapshot().selectedIds].sort()).toEqual([...expected].sort());
      }
      expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
      expect(session.history.undoStack).toHaveLength(0);
    }));
  });

  it('ignores stale previews, keeps valid drafts, and never commits after the selected object is deleted', () => {
    const { session, doc } = fixture();
    applySceneCommand(doc, { type: 'create', objects: [{ ...OBJECT, id: OTHER }] }, Symbol(), true);
    expect(session.beginGesture()).toBe(false);
    session.previewGesture([{ id: ID, position: [9, 0, 0] }]);
    session.select(ID, false); expect(session.beginGesture()).toBe(true);
    session.previewGesture([{ id: ID, position: [1, 2, 3] }]);
    session.previewGesture([{ id: OTHER, position: [9, 0, 0] }]);
    session.previewGesture([{ id: ID, scale: [0, 1, 1] }]);
    expect(session.getSnapshot().objects.find((object) => object.id === ID)?.position).toEqual([1, 2, 3]);
    expect(readSceneDocument(doc).objects.find((object) => object.id === ID)?.position).toEqual([0, 0, 0]);
    applySceneCommand(doc, { type: 'delete', ids: [ID] }, Symbol(), true);
    expect(session.getSnapshot().selectedIds).toEqual([]);
    expect(session.getSnapshot().gestureActive).toBe(false);
    const bytes = Y.encodeStateAsUpdate(doc);
    session.endGesture(true);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
    expect(session.history.undoStack).toHaveLength(0);
  });

  it('ends draft state for personal undo/redo, preserves remote locking and respects viewer mode', () => {
    const { session, doc } = fixture();
    session.select(ID, false);
    session.execute({ type: 'patch', patches: [{ id: ID, name: 'Renamed' }] });
    session.beginGesture(); session.previewGesture([{ id: ID, position: [9, 0, 0] }]);
    session.historyStep('undo');
    expect(session.getSnapshot().gestureActive).toBe(false);
    expect(readSceneDocument(doc).objects).toEqual([OBJECT]);
    expect(session.getSnapshot().canRedo).toBe(true);
    applySceneCommand(doc, { type: 'lock', ids: [ID], locked: true }, Symbol(), true);
    session.historyStep('redo');
    expect(readSceneDocument(doc).objects).toEqual([{ ...OBJECT, name: 'Renamed', locked: true }]);
    session.setEnvironment({ ...EDITOR, readOnly: true }); session.historyStep('undo');
    expect(readSceneDocument(doc).objects).toEqual([{ ...OBJECT, name: 'Renamed', locked: true }]);
  });

  it('treats remote hints as validated temporary data while keeping local editing independent', () => {
    const { session, doc } = fixture();
    applySceneCommand(doc, { type: 'create', objects: [{ ...OBJECT, id: OTHER }] }, Symbol(), true);
    applySceneCommand(doc, { type: 'lock', ids: [OTHER], locked: true }, Symbol(), true);
    const local = presence(doc, 'alice'); session.setEnvironment({ ...EDITOR, awareness: local });
    const remote = publishPeer(local, 'bob', {
      selectedIds: [ID, OTHER, MISSING],
      gesture: [{ ...OBJECT, position: [8, 0, 0] }, { ...OBJECT, id: OTHER }, { ...OBJECT, id: MISSING }],
    });
    publishPeer(local, 'bob', { selectedIds: [OTHER], gesture: null });
    publishPeer(local, 'aaron', { selectedIds: [ID], gesture: null });
    publishPeer(local, 'joining');
    expect(session.getSnapshot().remotePeers.map((peer) => peer.userId).sort()).toEqual(['aaron', 'bob', 'bob']);
    expect(session.getSnapshot().remotePeers.find((peer) => peer.clientId === remote.clientID)).toMatchObject({
      userId: 'bob', selectedIds: [ID, OTHER], gesture: [{ ...OBJECT, position: [8, 0, 0] }],
    });
    session.select(ID, false); expect(session.beginGesture()).toBe(true);
    expect(readSceneDocument(doc).objects.find((object) => object.id === ID)?.position).toEqual([0, 0, 0]);
    remote.setLocalState(null);
    applyAwarenessUpdate(local, encodeAwarenessUpdate(remote, [remote.clientID]), 'remote');
    expect(session.getSnapshot().remotePeers.some((peer) => peer.clientId === remote.clientID)).toBe(false);
  });

  it('withdraws from the replaced awareness and republishes only current selection after reconnect', async () => {
    const { session, doc } = fixture();
    const old = presence(doc, 'alice'); const current = presence(doc, 'alice');
    session.setEnvironment({ ...EDITOR, awareness: old }); session.setVisible(true); session.setFocused(true);
    session.select(ID, false); session.beginGesture(); session.previewGesture([{ id: ID, position: [9, 0, 0] }]);
    session.setEnvironment({ ...EDITOR, awareness: current });
    expect(old.getLocalState()?.scenePresence).toEqual({ selectedIds: [], gesture: null });
    expect(current.getLocalState()?.scenePresence).toEqual({ selectedIds: [ID], gesture: null });
    const snapshot = session.getSnapshot(); old.setLocalState({ user: { id: 'old' } });
    expect(session.getSnapshot()).toBe(snapshot);
    session.beginGesture(); session.previewGesture([{ id: ID, position: [9, 0, 0] }]);
    session.setEnvironment({ ...EDITOR, awareness: current, connected: false }); session.setFocused(true);
    expect(current.getLocalState()?.scenePresence).toEqual({ selectedIds: [], gesture: null });
    session.setEnvironment({ ...EDITOR, awareness: current });
    expect(current.getLocalState()?.scenePresence).toEqual({ selectedIds: [ID], gesture: null });
    expect(session.getSnapshot().gestureActive).toBe(false);
    current.setLocalState(null); session.setFocused(true);
    expect(current.getLocalState()).toBeNull();
  });

  it('notifies a live scene subscriber and stops notifying immediately after unsubscribe', async () => {
    const { session } = fixture();
    const listener = vi.fn(); const stop = session.subscribe(listener);
    try {
      session.select(ID, false);
      expect(listener).toHaveBeenCalledOnce();
      expect(session.getSnapshot().selectedIds).toEqual([ID]);
      stop(); session.select(null, false);
      expect(listener).toHaveBeenCalledOnce();
      expect(session.getSnapshot().selectedIds).toEqual([]);
    } finally { stop(); }
  });

});
