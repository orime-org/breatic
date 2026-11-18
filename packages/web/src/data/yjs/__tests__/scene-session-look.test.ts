// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { SCENE_FORMAT_VERSION } from '@breatic/shared';

import { applySceneCommand, readSceneDocument } from '@web/data/yjs/scene-document';
import { SceneSession, type SceneEnvironment } from '@web/data/yjs/scene-session';

const NAME = 'project-p1/3d-s1';

type Quaternion = [number, number, number, number];
type Vector = [number, number, number];

const ID = '11111111-1111-4111-8111-111111111111';
const START_LOOK = { 0: { color: '#112233', roughness: 0.4 }, 1: { metalness: 1 } };
const OBJECT = {
  id: ID, name: 'Figure', model: { kind: 'builtin' as const, id: 'figure' as const },
  position: [0, 0, 0] as Vector, rotation: [0, 0, 0, 1] as Quaternion,
  scale: [1, 1, 1] as Vector, locked: false, look: START_LOOK,
};
const EDITOR: Omit<SceneEnvironment, 'awareness'> = { readOnly: false, connected: true, hasEverSynced: true,
  writeAccess: 'granted', refused: false };
const cleanups: (() => void)[] = [];

interface Fixture {
  doc: Y.Doc;
  session: SceneSession;
  awareness: Awareness;
  /** Document updates and published gestures, in the order they happened. */
  log: unknown[];
}

/**
 * A visible, focused editor session on a scene holding one object with a look, with
 * the document listener attached before the session's own so a write is
 * logged before anything the session publishes in response to it.
 */
function fixture(): Fixture {
  const doc = new Y.Doc();
  doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  applySceneCommand(doc, { type: 'create', objects: [OBJECT] }, Symbol(), true, NAME);
  const log: unknown[] = [];
  doc.on('update', () => log.push('doc'));
  const awareness = new Awareness(doc);
  awareness.setLocalState({ user: { id: 'alice' } });
  const session = new SceneSession(doc, NAME);
  session.setEnvironment({ ...EDITOR, awareness });
  session.setVisible(true); session.setFocused(true); session.select(ID, false);
  awareness.on('update', () => {
    const presence = awareness.getLocalState()?.scenePresence as { gesture?: unknown } | undefined;
    log.push(structuredClone(presence?.gesture ?? null));
  });
  cleanups.push(() => { session.destroy(); awareness.destroy(); doc.destroy(); });
  return { doc, session, awareness, log };
}

/** Let every pending frame and interval run. */
function flush(): void {
  vi.advanceTimersByTime(1000);
}

/** Begin a gesture and let whatever it published settle, then forget the log. */
function begin(state: Fixture): void {
  expect(state.session.beginGesture()).toBe(true);
  flush();
  state.log.length = 0;
}

/** Bring a replica up to date with a source document. */
function deliver(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

/** The projected look of the main object in a document. */
function lookIn(doc: Y.Doc): unknown {
  return (readSceneDocument(doc).objects[0] as { look?: unknown } | undefined)?.look;
}

/** A look preview draft for one part field, as the appearance section sends it. */
function lookDraft(part: string, set: Record<string, unknown>): never {
  return [{ id: ID, look: { [part]: set } }] as never;
}

describe('dragging a look field (inner#1693 design 4.3)', () => {
  it('shows the dragged field merged into its part and keeps every other part while the document is unchanged', () => {
    const state = fixture();
    begin(state);
    state.session.previewGesture(lookDraft('0', { roughness: 0.9 }));
    expect((state.session.getSnapshot().objects[0] as { look?: unknown }).look)
      .toEqual({ 0: { color: '#112233', roughness: 0.9 }, 1: { metalness: 1 } });
    expect(lookIn(state.doc)).toEqual(START_LOOK);
  });

  it('writes the dragged field as one look command and one undo item on release', () => {
    const state = fixture();
    begin(state);
    state.session.previewGesture(lookDraft('0', { roughness: 0.6 }));
    state.session.previewGesture(lookDraft('0', { roughness: 0.9 }));
    const record = state.doc.getMap('objects').get(ID) as Y.Map<unknown>;
    const changed: string[] = [];
    record.observe((event) => changed.push(...event.keysChanged));

    state.session.endGesture(true);
    expect(changed).toEqual(['look.0.roughness']);
    expect(lookIn(state.doc)).toEqual({ 0: { color: '#112233', roughness: 0.9 }, 1: { metalness: 1 } });
    expect(state.session.history.undoStack).toHaveLength(1);
    state.session.historyStep('undo');
    expect(lookIn(state.doc)).toEqual(START_LOOK);
  });

  it('publishes the dragged objects to collaborators without their look, which they do not draw', () => {
    const state = fixture();
    begin(state);
    state.session.previewGesture(lookDraft('0', { roughness: 0.9 }));
    flush();
    const published = (state.awareness.getLocalState()?.scenePresence as { gesture: Array<Record<string, unknown>> }).gesture;
    expect(published.map((object) => object.id)).toEqual([ID]);
    expect('look' in published[0]!).toBe(false);
  });

  it('writes nothing when the field ends where the drag started', () => {
    const state = fixture();
    begin(state);
    const committed = Y.encodeStateAsUpdate(state.doc);
    state.session.previewGesture(lookDraft('0', { roughness: 0.9 }));
    state.session.previewGesture(lookDraft('0', { roughness: 0.4 }));
    state.session.endGesture(true);
    expect(Y.encodeStateAsUpdate(state.doc)).toEqual(committed);
    expect(state.session.history.undoStack).toHaveLength(0);
  });

  it('keeps a field another member committed to another part during the drag', () => {
    const state = fixture();
    const peer = new Y.Doc(); cleanups.push(() => peer.destroy());
    deliver(state.doc, peer);
    begin(state);
    state.session.previewGesture(lookDraft('0', { roughness: 0.9 }));
    applySceneCommand(peer, { type: 'look', id: ID, part: '1', set: { opacity: 0.5 } } as never, Symbol(), true, NAME);
    deliver(peer, state.doc);
    expect((state.session.getSnapshot().objects[0] as { look?: unknown }).look)
      .toEqual({ 0: { color: '#112233', roughness: 0.9 }, 1: { metalness: 1, opacity: 0.5 } });
    state.session.endGesture(true);
    expect(lookIn(state.doc)).toEqual({ 0: { color: '#112233', roughness: 0.9 }, 1: { metalness: 1, opacity: 0.5 } });
  });

  it('writes no transform patch for a look drag', () => {
    const state = fixture();
    begin(state);
    state.session.previewGesture(lookDraft('0', { opacity: 0.2 }));
    const record = state.doc.getMap('objects').get(ID) as Y.Map<unknown>;
    const changed: string[] = [];
    record.observe((event) => changed.push(...event.keysChanged));
    state.session.endGesture(true);
    expect(changed).toEqual(['look.0.opacity']);
  });

  it('drops the drag without writing when the object is locked during it', () => {
    const state = fixture();
    const peer = new Y.Doc(); cleanups.push(() => peer.destroy());
    deliver(state.doc, peer);
    begin(state);
    state.session.previewGesture(lookDraft('0', { roughness: 0.9 }));
    applySceneCommand(peer, { type: 'lock', ids: [ID], locked: true }, Symbol(), true, NAME);
    deliver(peer, state.doc);
    state.session.endGesture(true);
    expect(lookIn(state.doc)).toEqual(START_LOOK);
    expect(state.session.history.undoStack).toHaveLength(0);
  });

  it('ignores a preview whose look holds an invalid value', () => {
    const state = fixture();
    begin(state);
    state.session.previewGesture(lookDraft('0', { roughness: 5 }));
    expect((state.session.getSnapshot().objects[0] as { look?: unknown }).look).toEqual(START_LOOK);
  });
});
