// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { _resetForTests, destroyDoc, getDoc } from '@web/data/yjs/manager';
import { applySceneCommand, readSceneDocument } from '@web/data/yjs/scene-document';
import { evictSceneSession, getSceneSession, peekSceneSession, type SceneEnvironment, type SceneSession } from '@web/data/yjs/scene-session';

const NAME = 'project-shared-lifecycle/3d-scene';
const ID = '11111111-1111-4111-8111-111111111111';
const OBJECT = {
  id: ID, name: 'Figure', model: { kind: 'builtin' as const, id: 'figure' as const },
  position: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number], locked: false, exists: true,
};
const EDITOR: SceneEnvironment = {
  readOnly: false, connected: true, hasEverSynced: true,
  writeAccess: 'granted', refused: false, awareness: null,
};
const sessions = new Set<SceneSession>();
const openBrowserStore = vi.fn(() => { throw new Error('Scene content must stay in the collaborative document'); });

/** Build a scene from committed shared content and track its in-memory owner. */
function scene(): { doc: Y.Doc; session: SceneSession } {
  const doc = getDoc(NAME);
  doc.getMap('scene').set('formatVersion', 1);
  const result = applySceneCommand(doc, { type: 'create', objects: [OBJECT] }, Symbol('shared-content'), true);
  if (!result.ok) throw new Error('The shared scene fixture must contain its object');
  const session = getSceneSession(doc, NAME);
  sessions.add(session);
  session.setEnvironment(EDITOR);
  return { doc, session };
}

beforeEach(() => {
  openBrowserStore.mockClear();
  vi.stubGlobal('indexedDB', { open: openBrowserStore });
});

afterEach(() => {
  for (const session of sessions) session.destroy();
  sessions.clear();
  destroyDoc(NAME);
  _resetForTests();
  vi.restoreAllMocks();
});

describe('scene shared document lifecycle (inner#1724)', () => {
  it('creates, edits and closes without browser scene storage or a leave handler', () => {
    const listen = vi.spyOn(window, 'addEventListener');
    const { session } = scene();
    expect(session.execute({ type: 'patch', patches: [{ id: ID, name: 'Edited' }] })).toEqual({ ok: true, ids: [ID] });
    evictSceneSession(NAME);
    expect.soft(openBrowserStore).not.toHaveBeenCalled();
    expect.soft(listen.mock.calls.filter(([type]) => type === 'beforeunload')).toEqual([]);
  });

  it('evicts a closing session immediately and reopens with fresh personal history', () => {
    const { doc, session } = scene();
    session.execute({ type: 'patch', patches: [{ id: ID, name: 'Edited' }] });
    const stopHistory = vi.spyOn(session.history, 'destroy');
    expect(session.history.undoStack).toHaveLength(1);
    expect(session.getSnapshot().selectedIds).toEqual([]);
    session.select(ID, false);
    evictSceneSession(NAME);
    expect(stopHistory).toHaveBeenCalledOnce();
    expect(peekSceneSession(NAME)).toBeUndefined();
    const reopened = getSceneSession(doc, NAME);
    sessions.add(reopened);
    expect(reopened).not.toBe(session);
    expect(reopened.history.undoStack).toHaveLength(0);
    expect(reopened.getSnapshot().selectedIds).toEqual([]);
    expect(readSceneDocument(doc).objects).toEqual([{ ...OBJECT, name: 'Edited' }]);
  });

  it('destroys the document and its session without a recovery or export prerequisite', () => {
    const { doc, session } = scene();
    session.execute({ type: 'patch', patches: [{ id: ID, name: 'Edited' }] });
    const stopHistory = vi.spyOn(session.history, 'destroy');
    destroyDoc(NAME, doc);
    expect(doc.isDestroyed).toBe(true);
    expect(stopHistory).toHaveBeenCalledOnce();
    expect(peekSceneSession(NAME)).toBeUndefined();
    const reopenedDoc = getDoc(NAME);
    const reopened = getSceneSession(reopenedDoc, NAME);
    sessions.add(reopened);
    expect(reopenedDoc).not.toBe(doc);
    expect(reopened).not.toBe(session);
    expect(reopened.history.undoStack).toHaveLength(0);
    expect(reopened.getSnapshot().selectedIds).toEqual([]);
  });

  it('keeps selection and personal undo while hidden and cancels only the gesture draft', () => {
    const { doc, session } = scene();
    session.setVisible(true);
    session.select(ID, false);
    session.execute({ type: 'patch', patches: [{ id: ID, name: 'Edited' }] });
    expect(session.beginGesture()).toBe(true);
    session.previewGesture([{ id: ID, position: [9, 0, 0] }]);
    const committed = Y.encodeStateAsUpdate(doc);
    session.setVisible(false);
    expect(getSceneSession(doc, NAME)).toBe(session);
    expect(session.getSnapshot().selectedIds).toEqual([ID]);
    expect(session.getSnapshot().gestureActive).toBe(false);
    expect(session.history.undoStack).toHaveLength(1);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(committed);
    session.setVisible(true);
    session.historyStep('undo');
    expect(readSceneDocument(doc).objects).toEqual([OBJECT]);
    session.historyStep('redo');
    expect(readSceneDocument(doc).objects).toEqual([{ ...OBJECT, name: 'Edited' }]);
  });

  it('waits for first sync then keeps editing the same in-memory document across disconnects', () => {
    const { doc, session } = scene();
    session.setEnvironment({ ...EDITOR, connected: false, hasEverSynced: false });
    const before = Y.encodeStateAsUpdate(doc);
    expect(session.getSnapshot().canEdit).toBe(false);
    expect(session.execute({ type: 'patch', patches: [{ id: ID, name: 'Before sync' }] })).toEqual({ ok: false, reason: 'readOnly' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    session.setEnvironment(EDITOR);
    expect(session.getSnapshot().canEdit).toBe(true);
    expect(session.execute({ type: 'patch', patches: [{ id: ID, name: 'After sync' }] })).toEqual({ ok: true, ids: [ID] });
    session.setEnvironment({ ...EDITOR, connected: false, writeAccess: 'unknown' });
    expect(session.getSnapshot().canEdit).toBe(true);
    expect(session.execute({ type: 'patch', patches: [{ id: ID, position: [4, 5, 6] }] })).toEqual({ ok: true, ids: [ID] });
    session.setEnvironment(EDITOR);
    expect(getDoc(NAME)).toBe(doc);
    expect(getSceneSession(doc, NAME)).toBe(session);
    expect(readSceneDocument(doc).objects).toEqual([{ ...OBJECT, name: 'After sync', position: [4, 5, 6] }]);
  });
});
