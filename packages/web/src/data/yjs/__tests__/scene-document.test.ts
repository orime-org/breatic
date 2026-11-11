// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';

import { SCENE_FORMAT_VERSION } from '@breatic/shared';

import type * as SceneDocument from '../scene-document';

const NAME = 'project-p1/3d-s1';

type SceneModule = typeof SceneDocument;
type RootShape = 'text' | 'array' | 'mixed';
const modules = import.meta.glob<SceneModule>('../scene-document.ts');
const documents: Y.Doc[] = [];
const incompatibleRoots = ['scene', 'objects'].flatMap((root) =>
  (['text', 'array', 'mixed'] as const).flatMap((shape) =>
    [false, true].map((encoded) => ({ root, shape, encoded })),
  ),
);
const ID = '11111111-1111-4111-8111-111111111111';
const COPY = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';
const ORIGINAL = {
  id: ID, name: 'Figure', model: { kind: 'builtin' as const, id: 'figure' as const },
  position: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number], locked: false,
};

/**
 * Loads the real module after asserting that the required implementation exists.
 * @throws {AssertionError} When the real command module is missing.
 */
async function loadScene(): Promise<SceneModule> {
  const loader = modules['../scene-document.ts'];
  expect(typeof loader, 'the real scene-document command module must exist').toBe('function');
  return loader();
}

/** Creates an isolated scene in the current format for a test. */
function sceneDoc(): Y.Doc {
  const doc = new Y.Doc();
  documents.push(doc);
  doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  doc.getMap('objects');
  return doc;
}

/** Restores a real Yjs replica without sharing in-memory values. */
function replica(source: Y.Doc): Y.Doc {
  const doc = new Y.Doc();
  documents.push(doc);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return doc;
}

/** Creates incompatible sequence content through public Yjs APIs before any scene read binds the roots. */
function incompatibleDocument(root: string, shape: RootShape, encoded: boolean): Y.Doc {
  const source = new Y.Doc();
  documents.push(source);
  if (root === 'objects') source.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  if (shape === 'text') source.getText(root).insert(0, 'incompatible root');
  else if (shape === 'array') source.getArray(root).push(['incompatible root', 17]);
  else {
    source.getMap(root).set(root === 'scene' ? 'formatVersion' : 'retained', root === 'scene' ? SCENE_FORMAT_VERSION : true);
    const peer = new Y.Doc();
    documents.push(peer);
    peer.getText(root).insert(0, 'sequence merged into map');
    Y.applyUpdate(source, Y.encodeStateAsUpdate(peer));
  }
  return encoded ? replica(source) : source;
}

/** Exchanges both pre-merge updates so neither replica gets priority by arrival order. */
function merge(left: Y.Doc, right: Y.Doc): void {
  const leftUpdate = Y.encodeStateAsUpdate(left);
  const rightUpdate = Y.encodeStateAsUpdate(right);
  Y.applyUpdate(left, rightUpdate);
  Y.applyUpdate(right, leftUpdate);
}

afterEach(() => {
  for (const doc of documents.splice(0)) doc.destroy();
});

describe('scene projection and command transactions', () => {
  it('reads an uninitialized document without initializing or writing it', async () => {
    const { readSceneDocument } = await loadScene();
    const doc = new Y.Doc(); documents.push(doc);
    const before = Y.encodeStateAsUpdate(doc);
    expect(readSceneDocument(doc)).toMatchObject({ status: 'loading', objects: [], invalidObjects: [] });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('reads an empty supported scene and plans a create without writing', async () => {
    const { readSceneDocument, planSceneCommand } = await loadScene();
    const doc = sceneDoc(); const before = Y.encodeStateAsUpdate(doc);
    expect(readSceneDocument(doc)).toMatchObject({ status: 'ready', objects: [], invalidObjects: [] });
    expect(planSceneCommand(doc, NAME, { type: 'create', objects: [ORIGINAL] }, true).ok).toBe(true);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('retains valid Map-root scene values through binary restoration and accepts a subsequent command', async () => {
    const { applySceneCommand, planSceneCommand, readSceneDocument, validateSceneRecovery } = await loadScene();
    const source = sceneDoc();
    expect(applySceneCommand(source, { type: 'create', objects: [ORIGINAL] }, Symbol(), true, NAME)).toEqual({ ok: true, ids: [ID] });
    const restored = replica(source);
    const before = Y.encodeStateAsUpdate(restored);
    expect(() => validateSceneRecovery(restored)).not.toThrow();
    expect(readSceneDocument(restored)).toMatchObject({ status: 'ready', objects: [ORIGINAL], invalidObjects: [] });
    const command = { type: 'patch' as const, patches: [{ id: ID, position: [7, 8, 9] as [number, number, number] }] };
    expect(planSceneCommand(restored, NAME, command, true).ok).toBe(true);
    expect(Y.encodeStateAsUpdate(restored)).toEqual(before);
    expect(applySceneCommand(restored, command, Symbol(), true, NAME)).toEqual({ ok: true, ids: [ID] });
    expect(readSceneDocument(restored).objects).toEqual([{ ...ORIGINAL, position: [7, 8, 9] }]);
    expect(readSceneDocument(source).objects).toEqual([ORIGINAL]);
  });

  it('creates one record of plain current values in a single local transaction under personal undo', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol(); const history = createSceneHistory(doc, origin);
    const origins: unknown[] = [];
    doc.on('afterTransaction', (transaction) => origins.push(transaction.origin));
    expect(applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, origin, true, NAME)).toEqual({ ok: true, ids: [ID] });
    const record = doc.getMap('objects').get(ID) as Y.Map<unknown>;
    expect(record).toBeInstanceOf(Y.Map);
    const { id: _id, ...values } = ORIGINAL;
    expect(record.toJSON()).toEqual(values);
    for (const key of record.keys()) expect(record.get(key)).not.toBeInstanceOf(Y.AbstractType);
    expect(origins).toEqual([origin]);
    expect(readSceneDocument(doc).objects).toEqual([ORIGINAL]);
    expect(history.undoStack).toHaveLength(1);
    history.undo();
    expect(readSceneDocument(doc).objects).toEqual([]);
    expect(doc.getMap('objects').has(ID)).toBe(false);
    history.redo();
    expect(readSceneDocument(doc).objects).toEqual([ORIGINAL]);
    history.destroy();
  });

  it('overwrites changed fields in place and undoes an entire multi-object command in one step', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol();
    expect(applySceneCommand(doc, { type: 'create', objects: [ORIGINAL, { ...ORIGINAL, id: COPY }] }, Symbol(), true, NAME)).toEqual({ ok: true, ids: [ID, COPY] });
    const history = createSceneHistory(doc, origin);
    const record = doc.getMap('objects').get(ID) as Y.Map<unknown>;
    const patch = { id: ID, name: 'Moved', position: [1, 2, 3] as [number, number, number], rotation: [0.5, 0.5, 0.5, 0.5] as [number, number, number, number], scale: [2, 3, 4] as [number, number, number] };
    expect(applySceneCommand(doc, { type: 'patch', patches: [patch, { id: COPY, name: 'Peer' }] }, origin, true, NAME)).toEqual({ ok: true, ids: [ID, COPY] });
    expect(readSceneDocument(doc).objects).toEqual([{ ...ORIGINAL, ...patch }, { ...ORIGINAL, id: COPY, name: 'Peer' }]);
    expect(doc.getMap('objects').get(ID)).toBe(record);
    const { id: _id, ...patched } = { ...ORIGINAL, ...patch };
    expect(record.toJSON()).toEqual(patched);
    expect(history.undoStack).toHaveLength(1);
    history.undo();
    expect(readSceneDocument(doc).objects).toEqual([ORIGINAL, { ...ORIGINAL, id: COPY }]);
    history.redo();
    expect(readSceneDocument(doc).objects).toEqual([{ ...ORIGINAL, ...patch }, { ...ORIGINAL, id: COPY, name: 'Peer' }]);
    history.destroy();
  });

  it('stores fresh tuple values instead of retaining mutable command inputs', async () => {
    const { applySceneCommand, readSceneDocument } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol();
    const object = { ...ORIGINAL, position: [1, 2, 3] as [number, number, number] };
    expect(applySceneCommand(doc, { type: 'create', objects: [object] }, origin, true, NAME)).toEqual({ ok: true, ids: [ID] });
    object.position[0] = 99;
    expect(readSceneDocument(doc).objects).toEqual([{ ...ORIGINAL, position: [1, 2, 3] }]);
    const position: [number, number, number] = [4, 5, 6];
    expect(applySceneCommand(doc, { type: 'patch', patches: [{ id: ID, position }] }, origin, true, NAME)).toEqual({ ok: true, ids: [ID] });
    position[0] = 88;
    expect(readSceneDocument(doc).objects).toEqual([{ ...ORIGINAL, position: [4, 5, 6] }]);
  });

  it('rejects repeated targets without writing partial patch, delete or lock changes', async () => {
    const { applySceneCommand } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol();
    applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, origin, true, NAME);
    const before = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, { type: 'patch', patches: [{ id: ID, name: 'First' }, { id: ID, name: 'Second' }] }, origin, true, NAME)).toEqual({ ok: false, reason: 'invalid' });
    expect(applySceneCommand(doc, { type: 'delete', ids: [ID, ID] }, origin, true, NAME)).toEqual({ ok: false, reason: 'invalid' });
    expect(applySceneCommand(doc, { type: 'lock', ids: [ID, ID], locked: true }, origin, true, NAME)).toEqual({ ok: false, reason: 'invalid' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each(['create', 'patch', 'delete', 'lock', 'duplicate'] as const)('refuses read-only %s without writing', async (kind) => {
    const { applySceneCommand, planSceneCommand } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol();
    applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, origin, true, NAME);
    const commands = {
      create: { type: 'create', objects: [{ ...ORIGINAL, id: COPY }] },
      patch: { type: 'patch', patches: [{ id: ID, name: 'Changed' }] },
      delete: { type: 'delete', ids: [ID] }, lock: { type: 'lock', ids: [ID], locked: true },
      duplicate: { type: 'duplicate', copies: [{ sourceId: ID, id: COPY }] },
    } satisfies Record<string, Parameters<SceneModule['applySceneCommand']>[1]>;
    const before = Y.encodeStateAsUpdate(doc);
    expect(planSceneCommand(doc, NAME, commands[kind], false)).toEqual({ ok: false, reason: 'readOnly' });
    expect(applySceneCommand(doc, commands[kind], origin, false, NAME)).toEqual({ ok: false, reason: 'readOnly' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each(['patch', 'delete', 'lock', 'duplicate'] as const)('rejects a missing target in a complete %s command atomically', async (kind) => {
    const { applySceneCommand, planSceneCommand } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol();
    applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, origin, true, NAME);
    const commands = {
      patch: { type: 'patch', patches: [{ id: ID, name: 'Changed' }, { id: COPY, name: 'Missing' }] },
      delete: { type: 'delete', ids: [ID, COPY] }, lock: { type: 'lock', ids: [ID, COPY], locked: true },
      duplicate: { type: 'duplicate', copies: [{ sourceId: ID, id: THIRD }, { sourceId: COPY, id: COPY }] },
    } satisfies Record<string, Parameters<SceneModule['applySceneCommand']>[1]>;
    const before = Y.encodeStateAsUpdate(doc);
    expect(planSceneCommand(doc, NAME, commands[kind], true)).toEqual({ ok: false, reason: 'missing' });
    expect(applySceneCommand(doc, commands[kind], origin, true, NAME)).toEqual({ ok: false, reason: 'missing' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('rejects a lock command whose locked value is not a boolean without writing', async () => {
    const { applySceneCommand } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol();
    applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, origin, true, NAME);
    const before = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, { type: 'lock', ids: [ID], locked: 'yes' as unknown as boolean }, origin, true, NAME)).toEqual({ ok: false, reason: 'invalid' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('rejects invalid multi-object creates and conflicting identities without writing', async () => {
    const { applySceneCommand } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol(); const empty = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, { type: 'create', objects: [ORIGINAL, { ...ORIGINAL, id: COPY, scale: [0, 1, 1] }] }, origin, true, NAME)).toEqual({ ok: false, reason: 'invalid' });
    expect(applySceneCommand(doc, { type: 'create', objects: [ORIGINAL, ORIGINAL] }, origin, true, NAME)).toEqual({ ok: false, reason: 'duplicate' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(empty);
    applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, origin, true, NAME);
    const before = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, origin, true, NAME)).toEqual({ ok: false, reason: 'duplicate' });
    expect(applySceneCommand(doc, { type: 'duplicate', copies: [{ sourceId: ID, id: ID }] }, origin, true, NAME)).toEqual({ ok: false, reason: 'duplicate' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each([{ name: '' }, { position: [Infinity, 0, 0] }, { rotation: [0, 0, 0, 0] }, { scale: [1, -1, 1] }])(
    'rejects an invalid patch %j without applying an earlier valid target', async (invalid) => {
      const { applySceneCommand } = await loadScene();
      const doc = sceneDoc(); const origin = Symbol();
      applySceneCommand(doc, { type: 'create', objects: [ORIGINAL, { ...ORIGINAL, id: COPY }] }, origin, true, NAME);
      const before = Y.encodeStateAsUpdate(doc);
      const command = { type: 'patch', patches: [{ id: COPY, name: 'Changed' }, { id: ID, ...invalid }] } as Parameters<SceneModule['applySceneCommand']>[1];
      expect(applySceneCommand(doc, command, origin, true, NAME)).toEqual({ ok: false, reason: 'invalid' });
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    },
  );

  it('refuses locked changes to any member of a target set while preserving unlock and personal undo', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol();
    applySceneCommand(doc, { type: 'create', objects: [ORIGINAL, { ...ORIGINAL, id: COPY }] }, Symbol(), true, NAME);
    const history = createSceneHistory(doc, origin);
    applySceneCommand(doc, { type: 'patch', patches: [{ id: ID, name: 'Mine' }] }, origin, true, NAME);
    applySceneCommand(doc, { type: 'lock', ids: [ID], locked: true }, Symbol(), true, NAME);
    const before = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, { type: 'patch', patches: [{ id: COPY, position: [2, 3, 4] }, { id: ID, name: 'Blocked' }] }, origin, true, NAME)).toEqual({ ok: false, reason: 'locked' });
    expect(applySceneCommand(doc, { type: 'delete', ids: [COPY, ID] }, origin, true, NAME)).toEqual({ ok: false, reason: 'locked' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    history.undo();
    expect(readSceneDocument(doc).objects.find((object) => object.id === ID)).toEqual({ ...ORIGINAL, locked: true });
    expect(applySceneCommand(doc, { type: 'lock', ids: [ID], locked: false }, origin, true, NAME)).toEqual({ ok: true, ids: [ID] });
    expect(readSceneDocument(doc).objects).toEqual([ORIGINAL, { ...ORIGINAL, id: COPY }]);
    history.destroy();
  });

  it('duplicates a locked committed object into an independent record and an unlocked new identity', async () => {
    const { applySceneCommand, readSceneDocument } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol();
    applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, origin, true, NAME);
    applySceneCommand(doc, { type: 'patch', patches: [{ id: ID, name: 'Committed', scale: [2, 3, 4] }] }, origin, true, NAME);
    applySceneCommand(doc, { type: 'lock', ids: [ID], locked: true }, origin, true, NAME);
    expect(applySceneCommand(doc, { type: 'duplicate', copies: [{ sourceId: ID, id: COPY }] }, origin, true, NAME)).toEqual({ ok: true, ids: [COPY] });
    const copy = readSceneDocument(doc).objects.find((object) => object.id === COPY);
    expect(copy).toMatchObject({ id: COPY, model: ORIGINAL.model, rotation: ORIGINAL.rotation, scale: [2, 3, 4], locked: false });
    const sourceRecord = doc.getMap('objects').get(ID) as Y.Map<unknown>;
    const copyRecord = doc.getMap('objects').get(COPY) as Y.Map<unknown>;
    expect(copyRecord).toBeInstanceOf(Y.Map);
    expect(copyRecord).not.toBe(sourceRecord);
    for (const key of copyRecord.keys()) expect(copyRecord.get(key)).not.toBeInstanceOf(Y.AbstractType);
    for (const field of ['model', 'rotation', 'scale'] as const) expect(copyRecord.get(field)).not.toBe(sourceRecord.get(field));
    applySceneCommand(doc, { type: 'patch', patches: [{ id: COPY, name: 'Copy changed', position: [8, 9, 10] }] }, origin, true, NAME);
    expect(readSceneDocument(doc).objects.find((object) => object.id === ID)).toEqual({ ...ORIGINAL, name: 'Committed', scale: [2, 3, 4], locked: true });
    applySceneCommand(doc, { type: 'lock', ids: [ID], locked: false }, origin, true, NAME);
    applySceneCommand(doc, { type: 'patch', patches: [{ id: ID, scale: [5, 6, 7] }] }, origin, true, NAME);
    expect(readSceneDocument(doc).objects.find((object) => object.id === COPY)).toEqual({ ...copy, name: 'Copy changed', position: [8, 9, 10] });
  });

  it('removes a deleted record, refuses to duplicate it and restores it through personal undo', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol();
    applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, Symbol(), true, NAME);
    const history = createSceneHistory(doc, origin);
    expect(applySceneCommand(doc, { type: 'delete', ids: [ID] }, origin, true, NAME)).toEqual({ ok: true, ids: [ID] });
    expect(readSceneDocument(doc)).toMatchObject({ status: 'ready', objects: [], invalidObjects: [] });
    expect(doc.getMap('objects').has(ID)).toBe(false);
    const before = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, { type: 'duplicate', copies: [{ sourceId: ID, id: COPY }] }, origin, true, NAME)).toEqual({ ok: false, reason: 'missing' });
    expect(applySceneCommand(doc, { type: 'patch', patches: [{ id: ID, name: 'Gone' }] }, origin, true, NAME)).toEqual({ ok: false, reason: 'missing' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    history.undo(); expect(readSceneDocument(doc).objects).toEqual([ORIGINAL]);
    history.redo(); expect(readSceneDocument(doc).objects).toEqual([]);
    history.destroy();
  });

  it('reports an older format version as unsupported without reading or writing it', async () => {
    const { applySceneCommand, planSceneCommand, readSceneDocument } = await loadScene();
    const doc = new Y.Doc(); documents.push(doc);
    doc.getMap('scene').set('formatVersion', 1);
    const legacy = new Y.Map<unknown>();
    doc.getMap('objects').set(ID, legacy);
    legacy.set('initial', { ...ORIGINAL, exists: false });
    const flags = new Y.Array<boolean>();
    legacy.set('exists', flags);
    flags.push([true]);
    const before = Y.encodeStateAsUpdate(doc);
    expect(readSceneDocument(doc)).toEqual({ status: 'unsupported', version: 1, objects: [], invalidObjects: [] });
    expect(planSceneCommand(doc, NAME, { type: 'patch', patches: [{ id: ID, name: 'Changed' }] }, true)).toEqual({ ok: false, reason: 'unsupported' });
    expect(applySceneCommand(doc, { type: 'create', objects: [{ ...ORIGINAL, id: COPY }] }, Symbol(), true, NAME)).toEqual({ ok: false, reason: 'unsupported' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('preserves unknown format data and refuses commands without a write', async () => {
    const { applySceneCommand, planSceneCommand, readSceneDocument, validateSceneRecovery } = await loadScene();
    const doc = sceneDoc();
    doc.getMap('scene').set('formatVersion', 99);
    doc.getMap('objects').set(ID, { future: true });
    const before = Y.encodeStateAsUpdate(doc);
    expect(readSceneDocument(doc).status).toBe('unsupported');
    expect(planSceneCommand(doc, NAME, { type: 'create', objects: [ORIGINAL] }, true)).toEqual({ ok: false, reason: 'unsupported' });
    expect(applySceneCommand(doc, { type: 'delete', ids: [ID] }, Symbol(), true, NAME)).toEqual({ ok: false, reason: 'unsupported' });
    expect(() => validateSceneRecovery(doc)).not.toThrow();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each(['plain-record', 'missing-model', 'bad-model', 'shared-type-field', 'bad-name', 'bad-position', 'bad-rotation', 'bad-scale', 'bad-boolean'])(
    'isolates a stored %s error while retaining valid neighbors and original bytes', async (damage) => {
      const { applySceneCommand, readSceneDocument, validateSceneRecovery } = await loadScene();
      const doc = sceneDoc();
      applySceneCommand(doc, { type: 'create', objects: [ORIGINAL, { ...ORIGINAL, id: COPY }] }, Symbol(), true, NAME);
      const record = doc.getMap('objects').get(ID) as Y.Map<unknown>;
      if (damage === 'plain-record') doc.getMap('objects').set(ID, { damaged: true });
      else if (damage === 'missing-model') record.delete('model');
      else if (damage === 'bad-model') record.set('model', { kind: 'builtin', id: 'tree' });
      else if (damage === 'shared-type-field') record.set('position', Y.Array.from([1, 2, 3]));
      else if (damage === 'bad-name') record.set('name', '   ');
      else if (damage === 'bad-position') record.set('position', [Infinity, 0, 0]);
      else if (damage === 'bad-rotation') record.set('rotation', [0, 0, 0, 0]);
      else if (damage === 'bad-scale') record.set('scale', [0, 1, 1]);
      else record.set('locked', 'yes');
      const before = Y.encodeStateAsUpdate(doc);
      const snapshot = readSceneDocument(doc);
      expect(snapshot.status).toBe('ready');
      expect(snapshot.objects).toEqual([{ ...ORIGINAL, id: COPY }]);
      expect(snapshot.invalidObjects.map((object) => object.id)).toEqual([ID]);
      expect(() => validateSceneRecovery(doc)).not.toThrow();
      expect(applySceneCommand(doc, { type: 'patch', patches: [{ id: COPY, name: 'Neighbor' }, { id: ID, name: 'Invalid' }] }, Symbol(), true, NAME)).toEqual({ ok: false, reason: 'invalid' });
      expect(applySceneCommand(doc, { type: 'duplicate', copies: [{ sourceId: ID, id: THIRD }] }, Symbol(), true, NAME)).toEqual({ ok: false, reason: 'invalid' });
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    },
  );

  it.each([
    { field: 'name', model: { kind: 'builtin' as const, id: 'box' as const }, value: 'box' },
    { field: 'name', model: { kind: 'asset' as const, assetId: THIRD }, value: 'Model' },
    { field: 'position', model: ORIGINAL.model, value: [0, 0, 0] },
    { field: 'rotation', model: ORIGINAL.model, value: [0, 0, 0, 1] },
    { field: 'scale', model: ORIGINAL.model, value: [1, 1, 1] },
    { field: 'locked', model: ORIGINAL.model, value: false },
  ])('reads a record without $field as the default and keeps it editable and deletable', async ({ field, model, value }) => {
    const { applySceneCommand, readSceneDocument } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol();
    const object = { ...ORIGINAL, model, name: 'Named', position: [4, 5, 6] as [number, number, number],
      rotation: [0, 1, 0, 0] as [number, number, number, number], scale: [2, 2, 2] as [number, number, number] };
    applySceneCommand(doc, { type: 'create', objects: [object] }, origin, true, NAME);
    (doc.getMap('objects').get(ID) as Y.Map<unknown>).delete(field);
    expect(readSceneDocument(doc)).toMatchObject({ status: 'ready', objects: [{ ...object, [field]: value }], invalidObjects: [] });
    expect(applySceneCommand(doc, { type: 'patch', patches: [{ id: ID, position: [7, 8, 9] }] }, origin, true, NAME)).toEqual({ ok: true, ids: [ID] });
    expect(applySceneCommand(doc, { type: 'delete', ids: [ID] }, origin, true, NAME)).toEqual({ ok: true, ids: [ID] });
    expect(doc.getMap('objects').has(ID)).toBe(false);
  });

  it.each(['scene', 'objects'])('retains an incompatible %s root without throwing or mutating it', async (root) => {
    const { applySceneCommand, readSceneDocument, validateSceneRecovery } = await loadScene();
    const doc = new Y.Doc(); documents.push(doc);
    doc.getText(root).insert(0, 'incompatible root');
    const before = Y.encodeStateAsUpdate(doc);
    expect(readSceneDocument(doc).status).toBe('unsupported');
    expect(applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, Symbol(), true, NAME)).toEqual({ ok: false, reason: 'unsupported' });
    expect(() => validateSceneRecovery(doc)).toThrow();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each([0, -1, 1.5, Infinity, NaN, '1', null])('rejects invalid recovery version %s and retains the encoded data', async (version) => {
    const { readSceneDocument, validateSceneRecovery } = await loadScene();
    const doc = sceneDoc(); doc.getMap('scene').set('formatVersion', version);
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => validateSceneRecovery(doc)).toThrow('Invalid scene format version');
    expect(readSceneDocument(doc).status).toBe('unsupported');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each(['scene', 'objects'])('rejects recovery with existing %s data and missing format metadata', async (root) => {
    const { validateSceneRecovery } = await loadScene();
    const doc = new Y.Doc(); documents.push(doc); doc.getMap(root).set('existing', true);
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => validateSceneRecovery(doc)).toThrow('Missing scene format version');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('accepts empty and supported recovery documents without writing', async () => {
    const { validateSceneRecovery } = await loadScene();
    const empty = new Y.Doc(); documents.push(empty); const ready = sceneDoc();
    for (const doc of [empty, ready]) {
      const before = Y.encodeStateAsUpdate(doc);
      expect(() => validateSceneRecovery(doc)).not.toThrow();
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    }
  });
});

describe.each(incompatibleRoots)('incompatible $root $shape root with encoded=$encoded', ({ root, shape, encoded }) => {
  it('projects unsupported content without changing its encoded bytes', async () => {
    const { readSceneDocument } = await loadScene();
    const doc = incompatibleDocument(root, shape, encoded);
    const before = Y.encodeStateAsUpdate(doc);
    expect(readSceneDocument(doc).status).toBe('unsupported');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('rejects pure recovery validation without changing its encoded bytes', async () => {
    const { validateSceneRecovery } = await loadScene();
    const doc = incompatibleDocument(root, shape, encoded);
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => validateSceneRecovery(doc)).toThrow(Error);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('refuses command planning without changing its encoded bytes', async () => {
    const { planSceneCommand } = await loadScene();
    const doc = incompatibleDocument(root, shape, encoded);
    const before = Y.encodeStateAsUpdate(doc);
    expect(planSceneCommand(doc, NAME, { type: 'create', objects: [ORIGINAL] }, true)).toEqual({ ok: false, reason: 'unsupported' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('refuses command application without changing its encoded bytes', async () => {
    const { applySceneCommand } = await loadScene();
    const doc = incompatibleDocument(root, shape, encoded);
    const before = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, Symbol(), true, NAME)).toEqual({ ok: false, reason: 'unsupported' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});

describe('scene collaboration invariants with real Yjs replicas', () => {
  it('merges a legal offline patch with a peer lock and blocks new edits after that lock arrives', async () => {
    const { applySceneCommand, readSceneDocument } = await loadScene();
    const a = sceneDoc(); const oa = Symbol();
    applySceneCommand(a, { type: 'create', objects: [ORIGINAL] }, oa, true, NAME);
    const b = replica(a);
    expect(applySceneCommand(a, { type: 'patch', patches: [{ id: ID, position: [4, 5, 6] }] }, oa, true, NAME)).toEqual({ ok: true, ids: [ID] });
    expect(applySceneCommand(b, { type: 'lock', ids: [ID], locked: true }, Symbol(), true, NAME)).toEqual({ ok: true, ids: [ID] });
    merge(a, b);
    for (const doc of [a, b]) expect(readSceneDocument(doc).objects).toEqual([{ ...ORIGINAL, position: [4, 5, 6], locked: true }]);
    const before = Y.encodeStateAsUpdate(a);
    expect(applySceneCommand(a, { type: 'patch', patches: [{ id: ID, position: [7, 8, 9] }] }, oa, true, NAME)).toEqual({ ok: false, reason: 'locked' });
    expect(Y.encodeStateAsUpdate(a)).toEqual(before);
  });

  it('keeps a later peer value visible when an earlier local value is undone and redone', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    const a = sceneDoc(); const origin = Symbol();
    applySceneCommand(a, { type: 'create', objects: [ORIGINAL] }, Symbol(), true, NAME);
    const b = replica(a); const history = createSceneHistory(a, origin);
    applySceneCommand(a, { type: 'patch', patches: [{ id: ID, position: [1, 2, 3] }] }, origin, true, NAME);
    merge(a, b);
    applySceneCommand(b, { type: 'patch', patches: [{ id: ID, position: [4, 5, 6] }] }, Symbol(), true, NAME);
    merge(a, b);
    history.undo(); merge(a, b);
    for (const doc of [a, b]) expect(readSceneDocument(doc).objects).toEqual([{ ...ORIGINAL, position: [4, 5, 6] }]);
    history.redo(); merge(a, b);
    for (const doc of [a, b]) expect(readSceneDocument(doc).objects).toEqual([{ ...ORIGINAL, position: [4, 5, 6] }]);
    history.destroy();
  });

  it('merges independent properties in either update order and undoes only each authors records', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    fc.assert(fc.property(fc.tuple(fc.integer(), fc.integer(), fc.integer()).filter((position) => position.some((value) => value !== 0)), fc.stringMatching(/^[A-Za-z]{1,20}$/).filter((name) => name !== ORIGINAL.name), (position, name) => {
      const a = sceneDoc(); const oa = Symbol(); const ob = Symbol();
      applySceneCommand(a, { type: 'create', objects: [ORIGINAL] }, Symbol(), true, NAME);
      const b = replica(a); const leftOrder = replica(a); const rightOrder = replica(a);
      const ha = createSceneHistory(a, oa); const hb = createSceneHistory(b, ob);
      expect(applySceneCommand(a, { type: 'patch', patches: [{ id: ID, position }] }, oa, true, NAME)).toEqual({ ok: true, ids: [ID] });
      expect(applySceneCommand(b, { type: 'patch', patches: [{ id: ID, name }] }, ob, true, NAME)).toEqual({ ok: true, ids: [ID] });
      const ua = Y.encodeStateAsUpdate(a); const ub = Y.encodeStateAsUpdate(b);
      Y.applyUpdate(leftOrder, ua); Y.applyUpdate(leftOrder, ub);
      Y.applyUpdate(rightOrder, ub); Y.applyUpdate(rightOrder, ua); merge(a, b);
      for (const doc of [a, b, leftOrder, rightOrder]) expect(readSceneDocument(doc).objects).toEqual([{ ...ORIGINAL, position, name }]);
      expect(ha.undoStack).toHaveLength(1); expect(hb.undoStack).toHaveLength(1);
      ha.undo(); merge(a, b);
      expect(readSceneDocument(a).objects).toEqual([{ ...ORIGINAL, name }]);
      expect(readSceneDocument(b).objects).toEqual([{ ...ORIGINAL, name }]);
      hb.undo(); merge(a, b);
      expect(readSceneDocument(a).objects).toEqual([ORIGINAL]);
      expect(readSceneDocument(b).objects).toEqual([ORIGINAL]);
      ha.destroy(); hb.destroy();
    }), { seed: 1703, numRuns: 40 });
  });

  it('converges concurrent same-property tuples and keeps every record readable through either undo order', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    fc.assert(fc.property(fc.boolean(), fc.tuple(fc.integer(), fc.integer(), fc.integer()), fc.tuple(fc.integer(), fc.integer(), fc.integer()), (aFirst, pa, pb) => {
      const a = sceneDoc(); const oa = Symbol(); const ob = Symbol();
      applySceneCommand(a, { type: 'create', objects: [ORIGINAL] }, Symbol(), true, NAME);
      const b = replica(a); const leftOrder = replica(a); const rightOrder = replica(a);
      const ha = createSceneHistory(a, oa); const hb = createSceneHistory(b, ob);
      applySceneCommand(a, { type: 'patch', patches: [{ id: ID, position: pa }] }, oa, true, NAME);
      applySceneCommand(b, { type: 'patch', patches: [{ id: ID, position: pb }] }, ob, true, NAME);
      const ua = Y.encodeStateAsUpdate(a); const ub = Y.encodeStateAsUpdate(b);
      Y.applyUpdate(leftOrder, ua); Y.applyUpdate(leftOrder, ub);
      Y.applyUpdate(rightOrder, ub); Y.applyUpdate(rightOrder, ua); merge(a, b);
      expect(readSceneDocument(a).objects).toEqual(readSceneDocument(b).objects);
      expect(readSceneDocument(leftOrder).objects).toEqual(readSceneDocument(rightOrder).objects);
      expect(readSceneDocument(a).objects).toEqual(readSceneDocument(leftOrder).objects);
      expect([pa, pb]).toContainEqual(readSceneDocument(a).objects[0]?.position);
      for (const history of aFirst ? [ha, hb] : [hb, ha]) {
        history.undo(); merge(a, b);
        expect(readSceneDocument(a)).toEqual(readSceneDocument(b));
        expect(readSceneDocument(a).invalidObjects).toEqual([]);
        expect(readSceneDocument(a).objects).toHaveLength(1);
      }
      ha.destroy(); hb.destroy();
    }), { seed: 1704, numRuns: 40 });
  });

  it('keeps concurrent quaternion records normalized and readable through personal undo', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    const rotations: [number, number, number, number][] = [[0, 1, 0, 0], [0.5, 0.5, 0.5, 0.5], [1, 0, 0, 0]];
    fc.assert(fc.property(fc.constantFrom(...rotations), fc.constantFrom(...rotations), (ra, rb) => {
      const a = sceneDoc(); const oa = Symbol(); const ob = Symbol();
      applySceneCommand(a, { type: 'create', objects: [ORIGINAL] }, Symbol(), true, NAME);
      const b = replica(a); const ha = createSceneHistory(a, oa); const hb = createSceneHistory(b, ob);
      applySceneCommand(a, { type: 'patch', patches: [{ id: ID, rotation: ra }] }, oa, true, NAME);
      applySceneCommand(b, { type: 'patch', patches: [{ id: ID, rotation: rb }] }, ob, true, NAME);
      merge(a, b);
      expect(readSceneDocument(a).objects).toEqual(readSceneDocument(b).objects);
      expect([ra, rb]).toContainEqual(readSceneDocument(a).objects[0]?.rotation);
      expect(readSceneDocument(a).invalidObjects).toEqual([]);
      for (const history of [ha, hb]) {
        history.undo(); merge(a, b);
        expect(readSceneDocument(a)).toEqual(readSceneDocument(b));
        expect(readSceneDocument(a).invalidObjects).toEqual([]);
        expect([ORIGINAL.rotation, ra, rb]).toContainEqual(readSceneDocument(a).objects[0]?.rotation);
      }
      ha.destroy(); hb.destroy();
    }), { seed: 1705, numRuns: 20 });
  });

  it('reads a field emptied by an undone concurrent write as its default and keeps the object deletable', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    for (const [left, right] of [[1, 2], [2, 1]]) {
      const a = sceneDoc(); a.clientID = left; const oa = Symbol(); const ob = Symbol();
      applySceneCommand(a, { type: 'create', objects: [{ ...ORIGINAL, position: [3, 3, 3] }] }, Symbol(), true, NAME);
      const b = new Y.Doc(); documents.push(b); b.clientID = right; Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      const ha = createSceneHistory(a, oa); const hb = createSceneHistory(b, ob);
      applySceneCommand(a, { type: 'patch', patches: [{ id: ID, position: [1, 1, 1] }] }, oa, true, NAME);
      applySceneCommand(b, { type: 'patch', patches: [{ id: ID, position: [2, 2, 2] }] }, ob, true, NAME);
      merge(a, b);
      const winner = readSceneDocument(a).objects[0]?.position[0] === 1 ? ha : hb;
      winner.undo(); merge(a, b);
      expect((a.getMap('objects').get(ID) as Y.Map<unknown>).has('position')).toBe(false);
      for (const doc of [a, b]) {
        expect(readSceneDocument(doc)).toMatchObject({ objects: [{ ...ORIGINAL, position: [0, 0, 0] }], invalidObjects: [] });
      }
      expect(applySceneCommand(b, { type: 'delete', ids: [ID] }, ob, true, NAME)).toEqual({ ok: true, ids: [ID] });
      merge(a, b);
      for (const doc of [a, b]) expect(doc.getMap('objects').has(ID)).toBe(false);
      ha.destroy(); hb.destroy();
    }
  });

  it('restores the value my write replaced unless a peer wrote the field after my last write', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    const a = sceneDoc(); const oa = Symbol(); const ob = Symbol();
    applySceneCommand(a, { type: 'create', objects: [{ ...ORIGINAL, name: 'r0' }] }, ob, true, NAME);
    const b = replica(a); const history = createSceneHistory(a, oa);
    const rename = (doc: Y.Doc, origin: symbol, name: string): void => {
      expect(applySceneCommand(doc, { type: 'patch', patches: [{ id: ID, name }] }, origin, true, NAME).ok).toBe(true);
      merge(a, b);
    };
    rename(a, oa, 'l1'); rename(b, ob, 'r1');
    history.undo(); merge(a, b);
    for (const doc of [a, b]) expect(readSceneDocument(doc).objects[0]?.name).toBe('r1');
    rename(a, oa, 'l2');
    history.undo(); merge(a, b);
    for (const doc of [a, b]) expect(readSceneDocument(doc).objects[0]?.name).toBe('r1');
    history.destroy();
    const c = sceneDoc(); const oc = Symbol();
    applySceneCommand(c, { type: 'create', objects: [{ ...ORIGINAL, name: 'r0' }] }, ob, true, NAME);
    const d = replica(c); const sequence = createSceneHistory(c, oc);
    const write = (doc: Y.Doc, origin: symbol, name: string): void => {
      expect(applySceneCommand(doc, { type: 'patch', patches: [{ id: ID, name }] }, origin, true, NAME).ok).toBe(true);
      merge(c, d);
    };
    write(c, oc, 'l1'); write(d, ob, 'r1'); write(c, oc, 'l2');
    sequence.undo(); merge(c, d);
    for (const doc of [c, d]) expect(readSceneDocument(doc).objects[0]?.name).toBe('r1');
    sequence.undo(); merge(c, d);
    for (const doc of [c, d]) expect(readSceneDocument(doc).objects[0]?.name).toBe('r0');
    sequence.destroy();
  });

  it('restores a deleted record with a peer edit made before the delete', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    const a = sceneDoc(); const origin = Symbol();
    applySceneCommand(a, { type: 'create', objects: [ORIGINAL] }, Symbol(), true, NAME);
    const b = replica(a); const history = createSceneHistory(a, origin);
    applySceneCommand(b, { type: 'patch', patches: [{ id: ID, name: 'Peer value' }] }, Symbol(), true, NAME); merge(a, b);
    applySceneCommand(a, { type: 'delete', ids: [ID] }, origin, true, NAME); merge(a, b);
    for (const doc of [a, b]) expect(doc.getMap('objects').has(ID)).toBe(false);
    history.undo(); merge(a, b);
    for (const doc of [a, b]) expect(readSceneDocument(doc).objects).toEqual([{ ...ORIGINAL, name: 'Peer value' }]);
    history.destroy();
  });

  it('removes the record on creation undo and restores it with peer edits on redo', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    const a = sceneDoc(); const origin = Symbol(); const history = createSceneHistory(a, origin);
    applySceneCommand(a, { type: 'create', objects: [ORIGINAL] }, origin, true, NAME);
    const b = replica(a);
    applySceneCommand(b, { type: 'patch', patches: [{ id: ID, name: 'Peer value' }] }, Symbol(), true, NAME); merge(a, b);
    history.undo(); merge(a, b);
    for (const doc of [a, b]) {
      expect(readSceneDocument(doc).objects).toEqual([]);
      expect(doc.getMap('objects').has(ID)).toBe(false);
    }
    history.redo(); merge(a, b);
    for (const doc of [a, b]) expect(readSceneDocument(doc).objects).toEqual([{ ...ORIGINAL, name: 'Peer value' }]);
    history.destroy();
  });

  it('matches raw Yjs selective undo for my field writes interleaved with peer writes', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    const fieldValue = (field: 'name' | 'position' | 'scale', value: number): unknown =>
      field === 'name' ? `N${value}` : field === 'position' ? [value, 0, 0] : [value + 1, 1, 1];
    const step = fc.oneof(
      fc.record({ kind: fc.constant('set' as const), mine: fc.boolean(), object: fc.constantFrom(ID, COPY),
        field: fc.constantFrom('name' as const, 'position' as const, 'scale' as const), value: fc.nat(3) }),
      fc.record({ kind: fc.constantFrom('undo' as const, 'redo' as const) }),
    );
    fc.assert(fc.property(fc.array(step, { maxLength: 30 }), (steps) => {
      const peer = Symbol(); const mine = Symbol();
      const a = sceneDoc(); applySceneCommand(a, { type: 'create', objects: [ORIGINAL, { ...ORIGINAL, id: COPY }] }, peer, true, NAME);
      const b = replica(a); const history = createSceneHistory(a, mine);
      const rawA = new Y.Doc(); const rawB = new Y.Doc(); documents.push(rawA, rawB);
      rawA.transact(() => {
        for (const id of [ID, COPY]) {
          const { id: _id, ...values } = { ...ORIGINAL, id };
          rawA.getMap('objects').set(id, new Y.Map(Object.entries(structuredClone(values))));
        }
      }, peer);
      Y.applyUpdate(rawB, Y.encodeStateAsUpdate(rawA));
      const rawHistory = new Y.UndoManager(rawA.getMap('objects'), { trackedOrigins: new Set([mine]), captureTimeout: 0 });
      for (const action of steps) {
        if (action.kind === 'set') {
          const value = fieldValue(action.field, action.value);
          applySceneCommand(action.mine ? a : b, { type: 'patch', patches: [{ id: action.object, [action.field]: value }] }, action.mine ? mine : peer, true, NAME);
          const raw = action.mine ? rawA : rawB;
          const record = raw.getMap('objects').get(action.object) as Y.Map<unknown>;
          if (JSON.stringify(record.get(action.field)) !== JSON.stringify(value)) {
            raw.transact(() => record.set(action.field, structuredClone(value)), action.mine ? mine : peer);
          }
        } else if (action.kind === 'undo') { history.undo(); rawHistory.undo(); }
        else { history.redo(); rawHistory.redo(); }
        merge(a, b); merge(rawA, rawB);
        const expected = [ID, COPY].map((id) => ({ id, ...(rawA.getMap('objects').get(id) as Y.Map<unknown>).toJSON() }));
        expect(readSceneDocument(a)).toEqual({ status: 'ready', version: SCENE_FORMAT_VERSION, objects: expected, invalidObjects: [] });
        expect(readSceneDocument(b)).toEqual(readSceneDocument(a));
      }
      history.destroy(); rawHistory.destroy();
    }), { seed: 1875, numRuns: 200 });
  });

  it('keeps every record readable and changeable after unsynced commands, undo and redo', async () => {
    const { applySceneCommand, createSceneHistory, planSceneCommand, readSceneDocument } = await loadScene();
    const ids = [ID, COPY, THIRD];
    const step = fc.record({
      mine: fc.boolean(), sync: fc.boolean(), object: fc.constantFrom(...ids), value: fc.nat(3),
      kind: fc.constantFrom('create' as const, 'move' as const, 'rename' as const, 'lock' as const, 'delete' as const, 'undo' as const, 'redo' as const),
    });
    fc.assert(fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
      const a = sceneDoc(); const b = replica(a); const oa = Symbol(); const ob = Symbol();
      const histories = new Map([[a, createSceneHistory(a, oa)], [b, createSceneHistory(b, ob)]]);
      for (const action of steps) {
        const doc = action.mine ? a : b; const origin = action.mine ? oa : ob;
        if (action.kind === 'undo') histories.get(doc)?.undo();
        else if (action.kind === 'redo') histories.get(doc)?.redo();
        else {
          const command = action.kind === 'create' ? { type: 'create' as const, objects: [{ ...ORIGINAL, id: action.object }] }
            : action.kind === 'move' ? { type: 'patch' as const, patches: [{ id: action.object, position: [action.value, 0, 0] as [number, number, number] }] }
              : action.kind === 'rename' ? { type: 'patch' as const, patches: [{ id: action.object, name: `N${action.value}` }] }
                : action.kind === 'lock' ? { type: 'lock' as const, ids: [action.object], locked: action.value % 2 === 0 }
                  : { type: 'delete' as const, ids: [action.object] };
          applySceneCommand(doc, command, origin, true, NAME);
        }
        if (action.sync) merge(a, b);
      }
      merge(a, b);
      const sorted = (doc: Y.Doc): readonly SceneDocument.SceneDocumentSnapshot['objects'][number][] =>
        [...readSceneDocument(doc).objects].sort((left, right) => left.id.localeCompare(right.id));
      expect(sorted(a)).toEqual(sorted(b));
      for (const doc of [a, b]) {
        const snapshot = readSceneDocument(doc);
        expect(snapshot.invalidObjects).toEqual([]);
        for (const object of snapshot.objects) {
          expect(planSceneCommand(doc, NAME, { type: 'lock', ids: [object.id], locked: !object.locked }, true).ok).toBe(true);
          if (!object.locked) expect(planSceneCommand(doc, NAME, { type: 'delete', ids: [object.id] }, true).ok).toBe(true);
        }
      }
      for (const history of histories.values()) history.destroy();
    }), { seed: 1876, numRuns: 300 });
  });
});

describe('scene document size on a replica without personal history', () => {
  /** Creates a writer with objects and a replica that only receives updates, as collab persists it. */
  function writerAndReplica(applyCreate: SceneModule['applySceneCommand'], ids: readonly string[]): { writer: Y.Doc; stored: Y.Doc } {
    const writer = sceneDoc();
    expect(applyCreate(writer, { type: 'create', objects: ids.map((id) => ({ ...ORIGINAL, id })) }, Symbol(), true, NAME).ok).toBe(true);
    return { writer, stored: replica(writer) };
  }

  /** Sends every pending writer update to the stored replica. */
  function deliver(writer: Y.Doc, stored: Y.Doc): void {
    Y.applyUpdate(stored, Y.encodeStateAsUpdate(writer, Y.encodeStateVector(stored)));
  }

  it('does not grow when one client keeps overwriting the same field', async () => {
    const { applySceneCommand, createSceneHistory } = await loadScene();
    const { writer, stored } = writerAndReplica(applySceneCommand, [ID]);
    const origin = Symbol(); const history = createSceneHistory(writer, origin);
    const base = Y.encodeStateAsUpdate(stored).byteLength;
    for (let step = 1; step <= 10_000; step += 1) {
      applySceneCommand(writer, { type: 'patch', patches: [{ id: ID, position: [step, 0, 0] }] }, origin, true, NAME);
    }
    deliver(writer, stored);
    expect(Y.encodeStateAsUpdate(stored).byteLength - base).toBeLessThan(1024);
    history.destroy();
  });

  it('grows by at most twelve bytes per written field when edits switch fields and objects', async () => {
    const { applySceneCommand, createSceneHistory } = await loadScene();
    const ids = [ID, COPY, THIRD];
    fc.assert(fc.property(fc.array(fc.record({ object: fc.constantFrom(...ids), fields: fc.subarray(['name', 'position', 'scale'] as const, { minLength: 1 }) }), { minLength: 1, maxLength: 300 }), (edits) => {
      const { writer, stored } = writerAndReplica(applySceneCommand, ids);
      const origin = Symbol(); const history = createSceneHistory(writer, origin);
      const base = Y.encodeStateAsUpdate(stored).byteLength;
      let written = 0;
      edits.forEach(({ object, fields }, index) => {
        const value = index + 1;
        const patch = { id: object, ...(fields.includes('name') ? { name: `N${value}` } : {}),
          ...(fields.includes('position') ? { position: [value, 0, 0] as [number, number, number] } : {}),
          ...(fields.includes('scale') ? { scale: [value, 1, 1] as [number, number, number] } : {}) };
        expect(applySceneCommand(writer, { type: 'patch', patches: [patch] }, origin, true, NAME).ok).toBe(true);
        written += fields.length;
      });
      deliver(writer, stored);
      expect(Y.encodeStateAsUpdate(stored).byteLength - base).toBeLessThanOrEqual(written * 12 + 64);
      history.destroy();
    }), { seed: 1877, numRuns: 50 });
  });

  it('shrinks when objects are deleted', async () => {
    const { applySceneCommand } = await loadScene();
    const ids = Array.from({ length: 100 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    const { writer, stored } = writerAndReplica(applySceneCommand, ids);
    const before = Y.encodeStateAsUpdate(stored).byteLength;
    expect(applySceneCommand(writer, { type: 'delete', ids }, Symbol(), true, NAME).ok).toBe(true);
    deliver(writer, stored);
    expect(stored.getMap('objects').size).toBe(0);
    expect(Y.encodeStateAsUpdate(stored).byteLength).toBeLessThan(before / 2);
  });
});
