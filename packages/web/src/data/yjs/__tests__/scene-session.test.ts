// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { SceneSession, getSceneSession, evictSceneSession } from '../scene-session';
import { getDoc, destroyDoc } from '../manager';
import { applySceneCommand, readSceneDocument } from '../scene-document';

const ID = '11111111-1111-4111-8111-111111111111';
const OBJECT = { id: ID, name: 'Figure', model: { kind: 'builtin' as const, id: 'figure' as const },
  position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number], locked: false, exists: true };

describe('scene session lifecycle', () => {
  it('preserves an unsupported objects root without constructing an editable scene', async () => {
    const doc = new Y.Doc(); doc.getMap('scene').set('formatVersion', 1);
    doc.getText('objects').insert(0, 'invalid original objects root');
    const original = Y.encodeStateAsUpdate(doc);
    const session = new SceneSession(doc);
    expect(session.getSnapshot().status).toBe('unsupported');
    expect(session.getSnapshot().canEdit).toBe(false);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(original);
    session.destroy(); doc.destroy();
  });
  it('starts a new personal history after a tab closes and immediately reopens', async () => {
    const name = 'project-p/3d-s';
    const doc = getDoc(name); doc.getMap('scene').set('formatVersion', 1);
    const session = getSceneSession(doc, name);
    session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
    session.execute({ type: 'create', objects: [OBJECT] });
    expect(session.history.undoStack).toHaveLength(1);
    evictSceneSession(name);
    const reopened = getSceneSession(getDoc(name), name);
    expect(reopened).not.toBe(session);
    expect(reopened.history.undoStack).toHaveLength(0);
    expect(reopened.getSnapshot().selectedIds).toEqual([]);
    expect(reopened.getSnapshot().objects).toEqual([OBJECT]);
    destroyDoc(name, doc); expect(doc.isDestroyed).toBe(true);
  });
  it('keeps gestures local, commits one undo step and cancels without changing committed content', () => {
    const doc = new Y.Doc(); doc.getMap('scene').set('formatVersion', 1);
    applySceneCommand(doc, { type: 'create', objects: [OBJECT] }, Symbol(), true);
    const session = new SceneSession(doc);
    session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
    session.select(ID, false);
    expect(session.beginGesture()).toBe(true);
    session.previewGesture([{ id: ID, position: [2, 3, 4] }]);
    expect(readSceneDocument(doc).objects[0]?.position).toEqual([0, 0, 0]);
    expect(session.getSnapshot().objects[0]?.position).toEqual([2, 3, 4]);
    session.endGesture(true);
    expect(readSceneDocument(doc).objects[0]?.position).toEqual([2, 3, 4]);
    expect(session.history.undoStack).toHaveLength(1);
    session.beginGesture(); session.previewGesture([{ id: ID, position: [9, 9, 9] }]);
    session.endGesture(false); session.endGesture(true);
    expect(readSceneDocument(doc).objects[0]?.position).toEqual([2, 3, 4]);
    expect(session.history.undoStack).toHaveLength(1);
    session.history.undo(); expect(readSceneDocument(doc).objects).toEqual([OBJECT]);
    session.destroy(); doc.destroy();
  });

  it('ends the previous gesture synchronously when a command selects newly duplicated objects', () => {
    const doc = new Y.Doc(); doc.getMap('scene').set('formatVersion', 1);
    applySceneCommand(doc, { type: 'create', objects: [OBJECT] }, Symbol(), true);
    const awareness = new Awareness(doc);
    const session = new SceneSession(doc);
    session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness });
    session.setVisible(true); session.setFocused(true); session.select(ID, false);
    session.beginGesture(); session.previewGesture([{ id: ID, position: [9, 0, 0] }]);
    const copyId = '22222222-2222-4222-8222-222222222222';
    session.execute({ type: 'duplicate', copies: [{ sourceId: ID, id: copyId }] });
    expect(session.getSnapshot().gestureActive).toBe(false);
    expect(session.getSnapshot().selectedIds).toEqual([copyId]);
    expect(awareness.getLocalState()?.scenePresence).toEqual({ selectedIds: [copyId], gesture: null });
    expect(readSceneDocument(doc).objects.find((object) => object.id === ID)?.position).toEqual([0, 0, 0]);
    session.destroy(); awareness.destroy(); doc.destroy();
  });

  it('withdraws cancelled gestures immediately and republishes selection after focus returns', () => {
    const doc = new Y.Doc(); doc.getMap('scene').set('formatVersion', 1);
    applySceneCommand(doc, { type: 'create', objects: [OBJECT] }, Symbol(), true);
    const awareness = new Awareness(doc);
    const session = new SceneSession(doc);
    session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness });
    session.setVisible(true); session.setFocused(true); session.select(ID, false); session.beginGesture();
    session.previewGesture([{ id: ID, position: [3, 0, 0] }]);
    expect(awareness.getLocalState()?.scenePresence.gesture).toHaveLength(1);
    session.setFocused(false);
    expect(awareness.getLocalState()?.scenePresence).toEqual({ selectedIds: [], gesture: null });
    session.setFocused(true);
    expect(awareness.getLocalState()?.scenePresence).toEqual({ selectedIds: [ID], gesture: null });
    session.setVisible(false); session.setVisible(true);
    expect(session.getSnapshot().selectedIds).toEqual([ID]);
    session.destroy(); awareness.destroy(); doc.destroy();
  });

  it('cancels on remote lock and permission loss while viewer selection remains available', () => {
    const doc = new Y.Doc(); doc.getMap('scene').set('formatVersion', 1);
    applySceneCommand(doc, { type: 'create', objects: [OBJECT] }, Symbol(), true);
    const session = new SceneSession(doc);
    const env = { readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted' as const, refused: false, awareness: null };
    session.setEnvironment(env); session.select(ID, false); session.beginGesture(); session.previewGesture([{ id: ID, position: [2, 0, 0] }]);
    applySceneCommand(doc, { type: 'lock', ids: [ID], locked: true }, Symbol(), true);
    expect(session.getSnapshot().gestureActive).toBe(false);
    expect(session.getSnapshot().objects[0]?.position).toEqual([0, 0, 0]);
    session.setEnvironment({ ...env, readOnly: true });
    expect(session.execute({ type: 'delete', ids: [ID] })).toEqual({ ok: false, reason: 'readOnly' });
    session.select(null, false); session.select(ID, false);
    expect(session.getSnapshot().selectedIds).toEqual([ID]); expect(session.beginGesture()).toBe(false);
    session.destroy(); doc.destroy();
  });
});
