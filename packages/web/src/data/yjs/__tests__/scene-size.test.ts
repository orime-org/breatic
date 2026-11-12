// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec section
 * 8 and RQ-12: the 3D Space. `planSceneCommand` classifies each command
 * (create and duplicate `add`; patch and lock `edit`; unlock deletes the
 * `locked` key and delete removes the record, both `remove`); a refusal
 * answers `{ ok: false, reason }` with `full`, `over_ceiling` or
 * `resyncing`, and `SceneSession` shows the one toast.
 *
 * Commands go through `SceneSession.execute`, the production caller of
 * `applySceneCommand`. Initial scene, loaded as a peer's update: o1 unlocked,
 * o2 locked, o3 stored without a `locked` key.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { SCENE_FORMAT_VERSION, type SceneObject } from '@breatic/shared';

const { toast } = vi.hoisted(() => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@web/lib/toast', () => ({ toast, muteToasts: vi.fn(), _unmuteToastsForTests: vi.fn() }));

import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { readSceneDocument, type SceneCommand, type SceneCommandResult } from '@web/data/yjs/scene-document';
import { evictSceneSession, getSceneSession, type SceneSession } from '@web/data/yjs/scene-session';
import {
  SIZE_COPY_EN, captureWrite, enterSize, expectSizeToast, kindRows, loadRemote, type SizeCode,
} from '@web/data/yjs/__tests__/helpers/size-v2-harness';

const NAME = docName.threeDSpace('p1', 's1');
const O1 = '11111111-1111-4111-8111-111111111111';
const O2 = '22222222-2222-4222-8222-222222222222';
const O3 = '33333333-3333-4333-8333-333333333333';
const NEW = '44444444-4444-4444-8444-444444444444';
const COPY = '55555555-5555-4555-8555-555555555555';
const ASSET = '66666666-6666-4666-8666-666666666666';

/**
 * A builtin scene object.
 * @param id - Its id.
 * @param locked - Whether it is locked.
 * @returns The object.
 */
function object(id: string, locked = false): SceneObject {
  return { id, name: 'Figure', model: { kind: 'builtin', id: 'figure' }, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked };
}

let doc: Y.Doc;
let session: SceneSession;

/**
 * Loads the scene into the registered document and opens an editable session.
 * @param o1Pose - Flat pose keys stored on o1's record (inner#1692).
 * @returns The document.
 */
function seed(o1Pose: Readonly<Record<string, readonly number[]>> = {}): Y.Doc {
  doc = getDoc(NAME);
  loadRemote(doc, (source) => {
    source.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
    const objects = source.getMap<unknown>('objects');
    for (const item of [object(O1), object(O2, true)]) {
      const { id, ...values } = item;
      objects.set(id, new Y.Map<unknown>(Object.entries(id === O1 ? { ...values, ...o1Pose } : values)));
    }
    const { id, locked: _locked, ...values } = object(O3);
    objects.set(id, new Y.Map<unknown>(Object.entries(values)));
  });
  session = getSceneSession(doc, NAME);
  session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
  return doc;
}

/**
 * The refusal a command answers in a state.
 * @param result - What `execute` returned.
 * @param _doc - The document.
 * @param code - The state.
 */
function refusedIn(result: SceneCommandResult, _doc: Y.Doc, code: SizeCode): void {
  expect(result).toEqual({ ok: false, reason: code === 'Z' ? 'resyncing' : code === 'O' || code === 'CEIL' ? 'over_ceiling' : 'full' });
}

/**
 * Runs a command on the session.
 * @param command - The command.
 * @returns Its result.
 */
function run(command: SceneCommand): () => SceneCommandResult {
  return () => session.execute(command);
}

afterEach(() => {
  evictSceneSession(NAME);
  clearAllDocSizes();
  _resetForTests();
  vi.clearAllMocks();
});

describe('SC-01 new objects are add', () => {
  kindRows({ id: 'SC-01', title: 'create', kind: 'add', name: NAME, seed, run: run({ type: 'create', objects: [object(NEW)] }),
    written: (result) => { expect(result).toEqual({ ok: true, ids: [NEW] }); }, refused: refusedIn });
  kindRows({ id: 'SC-01', title: 'duplicate', kind: 'add', name: NAME, seed, run: run({ type: 'duplicate', copies: [{ sourceId: O1, id: COPY }] }),
    written: (result) => { expect(result).toEqual({ ok: true, ids: [COPY] }); }, refused: refusedIn });
});

describe('SC-02 changing an object is edit', () => {
  kindRows({ id: 'SC-02', title: 'patch name', kind: 'edit', name: NAME, seed, run: run({ type: 'patch', patches: [{ id: O1, name: 'Renamed' }] }),
    refused: refusedIn });
  kindRows({ id: 'SC-02', title: 'patch transform', kind: 'edit', name: NAME, seed,
    run: run({ type: 'patch', patches: [{ id: O1, position: [1, 2, 3], rotation: [0, 0, 1, 0], scale: [2, 2, 2] }] }), refused: refusedIn });
  kindRows({ id: 'SC-02', title: 'lock o1', kind: 'edit', name: NAME, seed, run: run({ type: 'lock', ids: [O1], locked: true }),
    written: () => { expect(readSceneDocument(doc).objects.find((o) => o.id === O1)?.locked).toBe(true); }, refused: refusedIn });
});

describe('SC-03 unlocking deletes the locked key: remove', () => {
  kindRows({ id: 'SC-03', title: 'unlock o2', kind: 'remove', name: NAME, seed, run: run({ type: 'lock', ids: [O2], locked: false }),
    written: (result, target) => {
      expect(result).toEqual({ ok: true, ids: [O2] });
      expect((target.getMap('objects').get(O2) as Y.Map<unknown>).has('locked')).toBe(false);
      expect(readSceneDocument(target).objects.find((o) => o.id === O2)?.locked).toBe(false);
    },
    refused: refusedIn });
});

describe('SC-04 deleting an object is remove', () => {
  kindRows({ id: 'SC-04', title: 'delete o1', kind: 'remove', name: NAME, seed, run: run({ type: 'delete', ids: [O1] }),
    written: (result, target) => { expect(result).toEqual({ ok: true, ids: [O1] }); expect(target.getMap('objects').has(O1)).toBe(false); },
    refused: refusedIn });
});

/** A quarter turn about Y, as a pose stores it. */
const Q_Y90: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

/**
 * The initial scene with o1 posed: one flat pose key on its record (inner#1692).
 * @returns The document.
 */
function seedPosed(): Y.Doc {
  return seed({ 'pose.h:leftUpperArm': Q_Y90 });
}

describe('SC-09 posing a character is edit; resetting its pose deletes its keys: remove', () => {
  kindRows({ id: 'SC-09', title: 'pose a joint', kind: 'edit', name: NAME, seed,
    run: run({ type: 'pose', id: O1, set: { 'h:leftUpperArm': Q_Y90 }, replace: false }),
    written: (result, target) => {
      expect(result).toEqual({ ok: true, ids: [O1] });
      expect((target.getMap('objects').get(O1) as Y.Map<unknown>).get('pose.h:leftUpperArm')).toEqual(Q_Y90);
    },
    refused: refusedIn });
  kindRows({ id: 'SC-09', title: 'reset pose', kind: 'remove', name: NAME, seed: seedPosed,
    run: run({ type: 'pose', id: O1, set: {}, replace: true }),
    written: (result, target) => {
      expect(result).toEqual({ ok: true, ids: [O1] });
      expect((target.getMap('objects').get(O1) as Y.Map<unknown>).has('pose.h:leftUpperArm')).toBe(false);
    },
    refused: refusedIn });
});

describe('SC-05 a record without a locked key reads unlocked and can be deleted', () => {
  it('SC-05 o3 reads locked false', () => {
    seed();
    expect(readSceneDocument(doc).objects.find((o) => o.id === O3)?.locked).toBe(false);
  });

  it('SC-05 at F deleting o3 goes through as a whole-record delete', () => {
    seed();
    enterSize(NAME, 'F');
    toast.warning.mockClear();
    const captured = captureWrite(doc, () => session.execute({ type: 'delete', ids: [O3] }));
    expect(captured.result).toEqual({ ok: true, ids: [O3] });
    expect(captured.shape).toBe('R');
    expectSizeToast(null);
  });
});

describe('SC-06 the read-only check comes before the size check', () => {
  it('SC-06 a viewer of a full Space is answered readOnly without a toast', () => {
    seed();
    session.setEnvironment({ readOnly: true, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
    enterSize(NAME, 'F');
    toast.warning.mockClear();
    expect(session.execute({ type: 'create', objects: [object(NEW)] })).toEqual({ ok: false, reason: 'readOnly' });
    expectSizeToast(null);
  });
});

describe('SC-07 SceneSession shows the shared size sentence once per refusal', () => {
  it('SC-07 a refused create at F warns with the add sentence', () => {
    seed();
    enterSize(NAME, 'F');
    toast.warning.mockClear();
    session.execute({ type: 'create', objects: [object(NEW)] });
    expectSizeToast(SIZE_COPY_EN.T_ADD);
  });

  it('SC-07 a refused patch at O warns with the over-limit sentence', () => {
    seed();
    enterSize(NAME, 'O');
    toast.warning.mockClear();
    session.execute({ type: 'patch', patches: [{ id: O1, name: 'Renamed' }] });
    expectSizeToast(SIZE_COPY_EN.T_OVER);
  });

  it('SC-07 a refused create at Z shows no toast', () => {
    seed();
    enterSize(NAME, 'Z');
    toast.warning.mockClear();
    expect(session.execute({ type: 'create', objects: [object(NEW)] })).toEqual({ ok: false, reason: 'resyncing' });
    expectSizeToast(null);
  });
});

describe('SC-08 an unknown size writes every command', () => {
  it.each<[string, SceneCommand]>([
    ['create', { type: 'create', objects: [object(NEW)] }],
    ['duplicate', { type: 'duplicate', copies: [{ sourceId: O1, id: COPY }] }],
    ['patch', { type: 'patch', patches: [{ id: O1, name: 'Renamed' }] }],
    ['lock', { type: 'lock', ids: [O1], locked: true }],
    ['unlock', { type: 'lock', ids: [O2], locked: false }],
    ['delete', { type: 'delete', ids: [O1] }],
  ])('SC-08 %s is written at U', (_label, command) => {
    seed();
    const captured = captureWrite(doc, () => session.execute(command));
    expect(captured.result.ok).toBe(true);
    expect(captured.changed).toBe(true);
    expectSizeToast(null);
  });
});

describe('RQ-12 placing an imported model on a full Space is stopped by SceneSession', () => {
  it('RQ-12 the Place create at F writes nothing and warns once', () => {
    seed();
    enterSize(NAME, 'N');
    enterSize(NAME, 'F');
    toast.warning.mockClear();
    const before = Y.encodeStateAsUpdate(doc);
    // The command `placeTask` in SceneEditor sends for a finished model row.
    const captured = captureWrite(doc, () => session.execute({ type: 'create', objects: [{ id: NEW, name: 'Lamp', model: { kind: 'asset', assetId: ASSET },
      position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false }] }));
    expect(captured.result).toEqual({ ok: false, reason: 'full' });
    expect(captured.shape).toBe('∅');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expectSizeToast(SIZE_COPY_EN.T_ADD);
  });
});
