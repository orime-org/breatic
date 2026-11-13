// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { SCENE_FORMAT_VERSION, type SceneObject } from '@breatic/shared';

import { applySceneCommand, readSceneDocument } from '@web/data/yjs/scene-document';
import { SceneSession, type SceneEnvironment } from '@web/data/yjs/scene-session';

const NAME = 'project-p1/3d-s1';
const CAM = '00000000-0000-4000-8000-000000000001';
const CAMERA = { id: CAM, name: 'Camera 1', model: { kind: 'camera' }, position: [0, 1, 4], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
  locked: false, number: 1, focalLength: 35, frame: '16:9' } as unknown as SceneObject;
const EDITOR: Omit<SceneEnvironment, 'awareness'> = { readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false };
const cleanups: (() => void)[] = [];

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); vi.useRealTimers(); });

/** A visible, focused editor session on a scene holding one camera. */
function fixture(): { doc: Y.Doc; session: SceneSession; awareness: Awareness } {
  const doc = new Y.Doc();
  doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  applySceneCommand(doc, { type: 'create', objects: [CAMERA] }, Symbol(), true, NAME);
  const awareness = new Awareness(doc);
  awareness.setLocalState({ user: { id: 'alice' } });
  const session = new SceneSession(doc, NAME);
  session.setEnvironment({ ...EDITOR, awareness });
  session.setVisible(true); session.setFocused(true);
  cleanups.push(() => { session.destroy(); awareness.destroy(); doc.destroy(); });
  return { doc, session, awareness };
}

/** The camera as committed. */
function committed(doc: Y.Doc): SceneObject | undefined {
  return readSceneDocument(doc).objects.find((object) => object.id === CAM);
}

describe('the pilot draft of a camera (inner#1694 design 6.2)', () => {
  it('publishes the draft to collaborators without changing the committed record', () => {
    const { doc, session, awareness } = fixture();
    session.previewPilot(CAM, [0, 2, 5], [0, 0, 0, 1]);
    vi.advanceTimersByTime(1000);
    const gesture = (awareness.getLocalState()?.scenePresence as { gesture?: SceneObject[] }).gesture;
    expect(gesture).toEqual([expect.objectContaining({ id: CAM, position: [0, 2, 5] })]);
    expect(committed(doc)?.position).toEqual([0, 1, 4]);
    expect(session.getSnapshot().objects.find((object) => object.id === CAM)?.position).toEqual([0, 1, 4]);
  });

  it('writes a changed draft once as one undo step and withdraws it', () => {
    const { doc, session, awareness } = fixture();
    session.previewPilot(CAM, [0, 2, 5], [0, 0, 0, 1]);
    session.endPilot(true);
    expect(committed(doc)?.position).toEqual([0, 2, 5]);
    expect(session.history.undoStack).toHaveLength(1);
    expect((awareness.getLocalState()?.scenePresence as { gesture: unknown }).gesture).toBeNull();
    session.historyStep('undo');
    expect(committed(doc)?.position).toEqual([0, 1, 4]);
  });

  it('writes nothing when the draft equals the record or is dropped', () => {
    const { session } = fixture();
    session.previewPilot(CAM, [0, 1 + 5e-6, 4], [0, 0, 0, 1]);
    session.endPilot(true);
    session.previewPilot(CAM, [9, 9, 9], [0, 0, 0, 1]);
    session.endPilot(false);
    expect(session.history.undoStack).toHaveLength(0);
  });

  it('writes past the thresholds of design 3.4.1 and treats the opposite quaternion as the same turn', () => {
    const { session } = fixture();
    session.previewPilot(CAM, [0, 1, 4], [-0, -0, -0, -1]);
    session.endPilot(true);
    expect(session.history.undoStack).toHaveLength(0);
    session.previewPilot(CAM, [0, 1 + 2e-5, 4], [0, 0, 0, 1]);
    session.endPilot(true);
    expect(session.history.undoStack).toHaveLength(1);
    const half = 5e-4;
    session.previewPilot(CAM, [0, 1 + 2e-5, 4], [0, Math.sin(half), 0, Math.cos(half)]);
    session.endPilot(true);
    expect(session.history.undoStack).toHaveLength(2);
  });

  it('ignores a draft for a locked camera or a Viewer', () => {
    const { doc, session } = fixture();
    session.execute({ type: 'lock', ids: [CAM], locked: true });
    session.previewPilot(CAM, [0, 2, 5], [0, 0, 0, 1]);
    session.endPilot(true);
    expect(committed(doc)?.position).toEqual([0, 1, 4]);
  });
});
