// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { act, cleanup, render } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { CollabSocketProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { destroyDoc, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { applySceneCommand, readSceneDocument } from '@web/data/yjs/scene-document';
import { SceneConnectionLifetime } from '@web/data/yjs/scene-lifetime';
import { getSceneSession, type SceneSession } from '@web/data/yjs/scene-session';
import { SpaceConnectionContext } from '@web/data/yjs/space-connection';
import type { SocketState, WriteAccess } from '@web/data/yjs/use-socket';

const NAME = 'project-lifetime/3d-scene';
const ID = '11111111-1111-4111-8111-111111111111';
const OBJECT = {
  id: ID, name: 'Figure', model: { kind: 'builtin' as const, id: 'figure' as const },
  position: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number], locked: false, exists: true,
};
const providers: HocuspocusProvider[] = [];
const sockets: HocuspocusProviderWebsocket[] = [];
const bodyStarted = vi.fn();
const bodyStopped = vi.fn();

/** Keep the real session's visible state with the Activity-managed editor body. */
function EditorBody({ session }: { session: SceneSession }): React.JSX.Element {
  React.useEffect(() => {
    bodyStarted();
    session.setVisible(true);
    session.setFocused(true);
    return (): void => {
      bodyStopped();
      session.setVisible(false);
      session.setFocused(false);
    };
  }, [session]);
  return <div>Scene body</div>;
}

/** Mount the real lifetime outside the body's real Activity boundary. */
function tab(connection: SocketState, readOnly = false, active = true): React.JSX.Element {
  return <CollabSocketProvider userId='account-a'>
    <SpaceConnectionContext.Provider value={connection}>
      <SceneConnectionLifetime name={NAME} readOnly={readOnly} />
      <React.Activity mode={active ? 'visible' : 'hidden'}>
        <EditorBody session={getSceneSession(getDoc(NAME), NAME)} />
      </React.Activity>
    </SpaceConnectionContext.Provider>
  </CollabSocketProvider>;
}

/** Build a real provider and awareness without opening any network connection. */
function provider(doc: Y.Doc): HocuspocusProvider {
  const socket = new HocuspocusProviderWebsocket({ url: 'ws://localhost/unused', autoConnect: false });
  sockets.push(socket);
  const awareness = new Awareness(doc);
  awareness.setLocalState({ user: { id: 'account-a' } });
  const result = new HocuspocusProvider({ name: NAME, document: doc, awareness, websocketProvider: socket });
  providers.push(result);
  return result;
}

/** Seed committed collaborative content and read its real cached editing owner. */
function fixture(): { doc: Y.Doc; session: SceneSession; connection: SocketState } {
  const doc = getDoc(NAME);
  doc.getMap('scene').set('formatVersion', 1);
  expect(applySceneCommand(doc, { type: 'create', objects: [OBJECT] }, Symbol('peer'), true)).toEqual({ ok: true, ids: [ID] });
  return { doc, session: getSceneSession(doc, NAME), connection: {
    provider: provider(doc), status: 'connected', synced: true, hasEverSynced: true,
    writeAccess: 'granted', authFailedReason: null,
  } };
}

/** Establish the personal state which connection changes must preserve. */
function edit(session: SceneSession): void {
  session.select(ID, false);
  expect(session.execute({ type: 'patch', patches: [{ id: ID, name: 'Edited' }] })).toEqual({ ok: true, ids: [ID] });
  expect(session.history.undoStack).toHaveLength(1);
}

beforeEach(() => {
  _resetCollabSocketForTests();
  _resetForTests();
  bodyStarted.mockClear();
  bodyStopped.mockClear();
});

afterEach(() => {
  cleanup();
  destroyDoc(NAME);
  for (const item of providers.splice(0)) item.destroy();
  for (const item of sockets.splice(0)) item.destroy();
  _resetCollabSocketForTests();
  _resetForTests();
});

describe('real scene connection lifetime outside a hidden Activity body', () => {
  it.each([
    { restriction: 'Project role', readOnly: true, writeAccess: 'granted' as WriteAccess },
    { restriction: 'server scope', readOnly: false, writeAccess: 'denied' as WriteAccess },
  ])('updates $restriction while hidden without losing selection or personal history', ({ readOnly, writeAccess }) => {
    const { doc, session, connection } = fixture();
    const { rerender } = render(tab(connection));
    edit(session);
    expect(session.beginGesture()).toBe(true);
    session.previewGesture([{ id: ID, position: [9, 0, 0] }]);
    expect(session.getSnapshot().gestureActive).toBe(true);
    const committed = Y.encodeStateAsUpdate(doc);

    rerender(tab(connection, false, false));
    expect(bodyStopped).toHaveBeenCalledOnce();
    expect(session.getSnapshot().gestureActive).toBe(false);
    expect(connection.provider?.awareness?.getLocalState()?.scenePresence).toEqual({ selectedIds: [], gesture: null });
    rerender(tab({ ...connection, writeAccess }, readOnly, false));

    expect(bodyStarted).toHaveBeenCalledOnce();
    expect(getSceneSession(getDoc(NAME), NAME)).toBe(session);
    expect(session.getSnapshot().canEdit).toBe(false);
    expect(session.getSnapshot().selectedIds).toEqual([ID]);
    expect(session.history.undoStack).toHaveLength(1);
    expect(session.execute({ type: 'patch', patches: [{ id: ID, name: 'Forbidden' }] })).toEqual({ ok: false, reason: 'readOnly' });
    session.historyStep('undo');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(committed);

    rerender(tab(connection, false, false));
    expect(session.getSnapshot().canEdit).toBe(true);
    expect(bodyStarted).toHaveBeenCalledOnce();
    session.historyStep('undo');
    expect(readSceneDocument(doc).objects).toEqual([OBJECT]);
    session.historyStep('redo');
    expect(readSceneDocument(doc).objects).toEqual([{ ...OBJECT, name: 'Edited' }]);
    rerender(tab(connection));
    expect(getSceneSession(getDoc(NAME), NAME)).toBe(session);
    expect(session.getSnapshot().selectedIds).toEqual([ID]);
    expect(connection.provider?.awareness?.getLocalState()?.scenePresence).toEqual({ selectedIds: [ID], gesture: null });
  });

  it('applies first-sync updates while hidden and retains the approved offline editing policy', () => {
    const { doc, session, connection } = fixture();
    const waiting: SocketState = { ...connection, status: 'connecting', synced: false, hasEverSynced: false, writeAccess: 'unknown' };
    const { rerender } = render(tab(waiting));
    rerender(tab(waiting, false, false));
    const committed = Y.encodeStateAsUpdate(doc);
    expect(session.getSnapshot().canEdit).toBe(false);
    expect(session.execute({ type: 'patch', patches: [{ id: ID, name: 'Too soon' }] })).toEqual({ ok: false, reason: 'readOnly' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(committed);

    rerender(tab(connection, false, false));
    expect(bodyStarted).toHaveBeenCalledOnce();
    expect(session.getSnapshot().canEdit).toBe(true);
    edit(session);
    const offline: SocketState = { ...connection, status: 'disconnected', synced: false, writeAccess: 'unknown' };
    rerender(tab(offline, false, false));
    expect(getSceneSession(getDoc(NAME), NAME)).toBe(session);
    expect(session.getSnapshot().canEdit).toBe(true);
    expect(session.execute({ type: 'patch', patches: [{ id: ID, position: [4, 5, 6] }] })).toEqual({ ok: true, ids: [ID] });
    expect(readSceneDocument(doc).objects).toEqual([{ ...OBJECT, name: 'Edited', position: [4, 5, 6] }]);
  });

  it('cancels the live gesture and withdraws presence when the Context disconnects', () => {
    const { doc, session, connection } = fixture();
    const { rerender } = render(tab(connection));
    edit(session);
    expect(session.beginGesture()).toBe(true);
    session.previewGesture([{ id: ID, position: [9, 0, 0] }]);
    expect(connection.provider?.awareness?.getLocalState()?.scenePresence).toEqual({ selectedIds: [ID], gesture: [{ ...OBJECT, name: 'Edited', position: [9, 0, 0] }] });
    const committed = Y.encodeStateAsUpdate(doc);
    const offline: SocketState = { ...connection, status: 'disconnected', synced: false };

    rerender(tab(offline));
    expect(session.getSnapshot().gestureActive).toBe(false);
    expect(session.getSnapshot().selectedIds).toEqual([ID]);
    expect(session.history.undoStack).toHaveLength(1);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(committed);
    expect(connection.provider?.awareness?.getLocalState()?.scenePresence).toEqual({ selectedIds: [], gesture: null });
    rerender(tab(offline, false, false));
    rerender(tab(connection, false, false));
    expect(bodyStarted).toHaveBeenCalledOnce();
    expect(connection.provider?.awareness?.getLocalState()?.scenePresence).toEqual({ selectedIds: [], gesture: null });
    rerender(tab(connection));
    expect(connection.provider?.awareness?.getLocalState()?.scenePresence).toEqual({ selectedIds: [ID], gesture: null });
  });

  it('replaces awareness while hidden and resumes only on the current provider', () => {
    const { doc, session, connection } = fixture();
    const old = connection.provider!.awareness!;
    const { rerender } = render(tab(connection));
    edit(session);
    rerender(tab(connection, false, false));
    const replacement = provider(doc);
    const current: SocketState = { ...connection, provider: replacement };
    rerender(tab(current, false, false));
    expect(bodyStarted).toHaveBeenCalledOnce();
    expect(getSceneSession(getDoc(NAME), NAME)).toBe(session);
    expect(session.getSnapshot().selectedIds).toEqual([ID]);
    expect(session.history.undoStack).toHaveLength(1);
    expect(old.getLocalState()?.scenePresence).toEqual({ selectedIds: [], gesture: null });
    expect(replacement.awareness?.getLocalState()?.scenePresence).toEqual({ selectedIds: [], gesture: null });
    const snapshot = session.getSnapshot();
    act(() => old.setLocalStateField('retired-provider', true));
    expect(session.getSnapshot()).toBe(snapshot);

    rerender(tab(current));
    expect(replacement.awareness?.getLocalState()?.scenePresence).toEqual({ selectedIds: [ID], gesture: null });
    expect(old.getLocalState()?.scenePresence).toEqual({ selectedIds: [], gesture: null });
    expect(session.getSnapshot().gestureActive).toBe(false);
  });
});
