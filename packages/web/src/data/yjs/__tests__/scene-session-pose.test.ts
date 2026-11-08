// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { SCENE_FORMAT_VERSION } from '@breatic/shared';

import { applySceneCommand, readSceneDocument } from '@web/data/yjs/scene-document';
import { SceneSession, type SceneEnvironment } from '@web/data/yjs/scene-session';

type Quaternion = [number, number, number, number];
type Vector = [number, number, number];

const ID = '11111111-1111-4111-8111-111111111111';
const Q_Y90: Quaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
const Q_X180: Quaternion = [1, 0, 0, 0];
const Q_Z180: Quaternion = [0, 0, 1, 0];
const Q_HALF: Quaternion = [0.5, 0.5, 0.5, 0.5];
const Q_NEG_HALF: Quaternion = [-0.5, 0.5, -0.5, 0.5];
const START_POSE = { 'h:leftUpperArm': Q_Y90, 'h:rightUpperArm': Q_X180 };
const OBJECT = {
  id: ID, name: 'Figure', model: { kind: 'builtin' as const, id: 'figure' as const },
  position: [0, 0, 0] as Vector, rotation: [0, 0, 0, 1] as Quaternion,
  scale: [1, 1, 1] as Vector, locked: false, pose: START_POSE,
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
 * A visible, focused editor session on a scene holding one posed object, with
 * the document listener attached before the session's own so a write is
 * logged before anything the session publishes in response to it.
 */
function fixture(): Fixture {
  const doc = new Y.Doc();
  doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  applySceneCommand(doc, { type: 'create', objects: [OBJECT] }, Symbol(), true);
  const log: unknown[] = [];
  doc.on('update', () => log.push('doc'));
  const awareness = new Awareness(doc);
  awareness.setLocalState({ user: { id: 'alice' } });
  const session = new SceneSession(doc);
  session.setEnvironment({ ...EDITOR, awareness });
  session.setVisible(true); session.setFocused(true); session.select(ID, false);
  awareness.on('update', () => {
    const presence = awareness.getLocalState()?.scenePresence as { gesture?: unknown } | undefined;
    log.push(structuredClone(presence?.gesture ?? null));
  });
  cleanups.push(() => { session.destroy(); awareness.destroy(); doc.destroy(); });
  return { doc, session, awareness, log };
}

/** The gesture this page currently publishes. */
function published(awareness: Awareness): unknown {
  return (awareness.getLocalState()?.scenePresence as { gesture?: unknown } | undefined)?.gesture;
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

describe('live gesture publishing (inner#1692 section 5.4)', () => {
  it('publishes drag previews through the shared throttle: not synchronously, once per frame, at least 33 ms apart', () => {
    const state = fixture();
    begin(state);
    const before = published(state.awareness);
    state.session.previewGesture([{ id: ID, position: [1, 0, 0] }]);
    state.session.previewGesture([{ id: ID, position: [2, 0, 0] }]);
    state.session.previewGesture([{ id: ID, position: [3, 0, 0] }]);
    expect(state.log).toEqual([]);
    expect(published(state.awareness)).toEqual(before);

    for (let step = 0; step < 100 && state.log.length === 0; step += 1) vi.advanceTimersByTime(1);
    expect(state.log).toEqual([[{ ...OBJECT, position: [3, 0, 0] }]]);

    state.session.previewGesture([{ id: ID, position: [4, 0, 0] }]);
    vi.advanceTimersByTime(20);
    expect(state.log).toHaveLength(1);
    vi.advanceTimersByTime(20);
    expect(state.log).toEqual([[{ ...OBJECT, position: [3, 0, 0] }], [{ ...OBJECT, position: [4, 0, 0] }]]);
  });

  it.each([
    { label: 'an object move', draft: { id: ID, position: [5, 0, 0] as Vector },
      final: { ...OBJECT, position: [5, 0, 0] } },
    { label: 'a joint rotation', draft: { id: ID, pose: { ...START_POSE, 'h:leftUpperArm': Q_HALF } },
      final: { ...OBJECT, pose: { ...START_POSE, 'h:leftUpperArm': Q_HALF } } },
  ])('commits $label as final gesture value, then the document write, then the withdrawal', ({ draft, final }) => {
    const state = fixture();
    begin(state);
    state.session.previewGesture([draft]);
    expect(state.log).toEqual([]);

    state.session.endGesture(true);
    expect(state.log).toEqual([[final], 'doc', null]);
    expect(readSceneDocument(state.doc).objects).toEqual([final]);
    expect(state.session.history.undoStack).toHaveLength(1);

    flush();
    expect(state.log).toEqual([[final], 'doc', null]);
    expect(state.awareness.getLocalState()?.scenePresence).toEqual({ selectedIds: [ID], gesture: null });
  });

  it.each([
    { label: 'an object move', draft: { id: ID, position: [5, 0, 0] as Vector } },
    { label: 'a joint rotation', draft: { id: ID, pose: { ...START_POSE, 'h:leftUpperArm': Q_HALF } } },
  ])('cancels $label by withdrawing at once and never writing the document', ({ draft }) => {
    const state = fixture();
    begin(state);
    const committed = Y.encodeStateAsUpdate(state.doc);
    state.session.previewGesture([draft]);

    state.session.endGesture(false);
    expect(state.log).toEqual([null]);
    flush();
    expect(state.log).toEqual([null]);
    expect(Y.encodeStateAsUpdate(state.doc)).toEqual(committed);
    expect(state.session.history.undoStack).toHaveLength(0);
    expect(state.session.getSnapshot().objects).toEqual([OBJECT]);
  });

  it('never lets a throttled preview land after the page loses focus', () => {
    const state = fixture();
    begin(state);
    state.session.previewGesture([{ id: ID, position: [5, 0, 0] }]);
    state.session.setFocused(false);
    expect(state.awareness.getLocalState()?.scenePresence).toEqual({ selectedIds: [], gesture: null });
    flush();
    expect(state.awareness.getLocalState()?.scenePresence).toEqual({ selectedIds: [], gesture: null });
  });

  it('never lets a throttled preview land after the session is destroyed', () => {
    const state = fixture();
    begin(state);
    state.session.previewGesture([{ id: ID, position: [5, 0, 0] }]);
    state.session.destroy();
    expect(state.awareness.getLocalState()?.scenePresence).toEqual({ selectedIds: [], gesture: null });
    flush();
    expect(state.awareness.getLocalState()?.scenePresence).toEqual({ selectedIds: [], gesture: null });
  });
});

describe('joint drag release (inner#1692 section 5.2, acceptance 7)', () => {
  it('writes only the bones this drag changed, keeping bones another member committed during the drag', () => {
    const state = fixture();
    const peer = new Y.Doc(); cleanups.push(() => peer.destroy());
    deliver(state.doc, peer);
    begin(state);
    state.session.previewGesture([{ id: ID, pose: { ...START_POSE, 'h:leftUpperArm': Q_HALF } }]);
    applySceneCommand(peer, { type: 'pose', id: ID, set: { 'h:rightUpperArm': Q_Z180, 'h:spine': Q_NEG_HALF }, clear: [] }, Symbol(), true);
    deliver(peer, state.doc);
    expect(state.session.getSnapshot().gestureActive).toBe(true);
    // The draft still carries the drag-start value of the bone the peer changed.
    state.session.previewGesture([{ id: ID, pose: { ...START_POSE, 'h:leftUpperArm': Q_Z180 } }]);

    const record = state.doc.getMap('objects').get(ID) as Y.Map<unknown>;
    const changed: string[] = [];
    record.observe((event) => changed.push(...event.keysChanged));
    state.session.endGesture(true);

    const expected = { 'h:leftUpperArm': Q_Z180, 'h:rightUpperArm': Q_Z180, 'h:spine': Q_NEG_HALF };
    expect(changed).toEqual(['pose.h:leftUpperArm']);
    expect(readSceneDocument(state.doc).objects).toEqual([{ ...OBJECT, pose: expected }]);
    expect(state.session.history.undoStack).toHaveLength(1);
    deliver(state.doc, peer);
    expect(readSceneDocument(peer).objects[0]?.pose).toEqual(expected);

    state.session.historyStep('undo');
    expect(readSceneDocument(state.doc).objects[0]?.pose)
      .toEqual({ 'h:leftUpperArm': Q_Y90, 'h:rightUpperArm': Q_Z180, 'h:spine': Q_NEG_HALF });
  });

  it('writes a bone first posed by this drag and leaves the transform untouched', () => {
    const state = fixture();
    begin(state);
    state.session.previewGesture([{ id: ID, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      pose: { ...START_POSE, 'n:Tail_1': Q_HALF } }]);
    const record = state.doc.getMap('objects').get(ID) as Y.Map<unknown>;
    const changed: string[] = [];
    record.observe((event) => changed.push(...event.keysChanged));

    state.session.endGesture(true);
    expect(changed).toEqual(['pose.n:Tail_1']);
    expect(record.has('pose')).toBe(false);
    expect(readSceneDocument(state.doc).objects).toEqual([{ ...OBJECT, pose: { ...START_POSE, 'n:Tail_1': Q_HALF } }]);
    expect(state.session.history.undoStack).toHaveLength(1);
    state.session.historyStep('undo');
    expect(readSceneDocument(state.doc).objects).toEqual([OBJECT]);
  });

  it('writes nothing when the joint ends where the drag started', () => {
    const state = fixture();
    begin(state);
    const committed = Y.encodeStateAsUpdate(state.doc);
    state.session.previewGesture([{ id: ID, pose: { ...START_POSE, 'h:leftUpperArm': Q_HALF } }]);
    state.session.previewGesture([{ id: ID, pose: { ...START_POSE } }]);

    state.session.endGesture(true);
    expect(Y.encodeStateAsUpdate(state.doc)).toEqual(committed);
    expect(state.session.history.undoStack).toHaveLength(0);
    expect(state.log).not.toContain('doc');
  });

  it('moves a posed object without touching any pose key', () => {
    const state = fixture();
    begin(state);
    state.session.previewGesture([{ id: ID, position: [2, 0, 3] }]);
    const record = state.doc.getMap('objects').get(ID) as Y.Map<unknown>;
    const changed: string[] = [];
    record.observe((event) => changed.push(...event.keysChanged));

    state.session.endGesture(true);
    expect(changed).toEqual(['position']);
    expect(readSceneDocument(state.doc).objects).toEqual([{ ...OBJECT, position: [2, 0, 3] }]);
    expect(state.session.history.undoStack).toHaveLength(1);
  });

  it('shows the dragged pose locally while the document keeps the committed pose', () => {
    const state = fixture();
    begin(state);
    state.session.previewGesture([{ id: ID, pose: { ...START_POSE, 'h:leftUpperArm': Q_HALF } }]);
    expect(state.session.getSnapshot().objects[0]?.pose).toEqual({ ...START_POSE, 'h:leftUpperArm': Q_HALF });
    expect(readSceneDocument(state.doc).objects[0]?.pose).toEqual(START_POSE);
  });

  it('ignores a preview whose pose holds an invalid value', () => {
    const state = fixture();
    begin(state);
    state.session.previewGesture([{ id: ID, pose: { ...START_POSE, 'h:leftUpperArm': Q_HALF } }]);
    state.session.previewGesture([{ id: ID, pose: { 'h:leftUpperArm': [2, 0, 0, 0] } }]);
    expect(state.session.getSnapshot().objects[0]?.pose).toEqual({ ...START_POSE, 'h:leftUpperArm': Q_HALF });
  });
});
