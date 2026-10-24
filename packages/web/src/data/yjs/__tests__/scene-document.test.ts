// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';

import type * as SceneDocument from '../scene-document';

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
const FIELDS = ['name', 'position', 'rotation', 'scale', 'locked', 'exists'] as const;
const ORIGINAL = {
  id: ID, name: 'Figure', model: { kind: 'builtin' as const, id: 'figure' as const },
  position: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number], locked: false, exists: true,
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

/** Creates an isolated version-one scene for a test. */
function sceneDoc(): Y.Doc {
  const doc = new Y.Doc();
  documents.push(doc);
  doc.getMap('scene').set('formatVersion', 1);
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
  if (root === 'objects') source.getMap('scene').set('formatVersion', 1);
  if (shape === 'text') source.getText(root).insert(0, 'incompatible root');
  else if (shape === 'array') source.getArray(root).push(['incompatible root', 17]);
  else {
    source.getMap(root).set(root === 'scene' ? 'formatVersion' : 'retained', root === 'scene' ? 1 : true);
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
    expect(planSceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, true).ok).toBe(true);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('retains valid Map-root scene values through binary restoration and accepts a subsequent command', async () => {
    const { applySceneCommand, planSceneCommand, readSceneDocument, validateSceneRecovery } = await loadScene();
    const source = sceneDoc();
    expect(applySceneCommand(source, { type: 'create', objects: [ORIGINAL] }, Symbol(), true)).toEqual({ ok: true, ids: [ID] });
    const restored = replica(source);
    const before = Y.encodeStateAsUpdate(restored);
    expect(() => validateSceneRecovery(restored)).not.toThrow();
    expect(readSceneDocument(restored)).toMatchObject({ status: 'ready', objects: [ORIGINAL], invalidObjects: [] });
    const command = { type: 'patch' as const, patches: [{ id: ID, position: [7, 8, 9] as [number, number, number] }] };
    expect(planSceneCommand(restored, command, true).ok).toBe(true);
    expect(Y.encodeStateAsUpdate(restored)).toEqual(before);
    expect(applySceneCommand(restored, command, Symbol(), true)).toEqual({ ok: true, ids: [ID] });
    expect(readSceneDocument(restored).objects).toEqual([{ ...ORIGINAL, position: [7, 8, 9] }]);
    expect(readSceneDocument(source).objects).toEqual([ORIGINAL]);
  });

  it('creates immutable initial values and six prebuilt sequences outside personal undo', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol(); const history = createSceneHistory(doc, origin);
    const origins: unknown[] = [];
    doc.on('afterTransaction', (transaction) => origins.push(transaction.origin));
    expect(applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, origin, true)).toEqual({ ok: true, ids: [ID] });
    const record = doc.getMap('objects').get(ID) as Y.Map<unknown>;
    expect(record).toBeInstanceOf(Y.Map);
    const { id: _id, ...initialValues } = ORIGINAL;
    expect(record.get('initial')).toEqual({ ...initialValues, exists: false });
    for (const field of FIELDS) {
      expect(record.get(field)).toBeInstanceOf(Y.Array);
      expect((record.get(field) as Y.Array<unknown>).toArray()).toEqual(field === 'exists' ? [true] : []);
    }
    expect(origins).toHaveLength(2);
    expect(origins[0]).not.toBe(origin);
    expect(origins[1]).toBe(origin);
    expect(readSceneDocument(doc).objects).toEqual([ORIGINAL]);
    expect(history.undoStack).toHaveLength(1);
    history.undo();
    expect(readSceneDocument(doc).objects).toEqual([]);
    expect(doc.getMap('objects').get(ID)).toBe(record);
    for (const field of FIELDS) expect(record.get(field)).toBeInstanceOf(Y.Array);
    history.redo();
    expect(readSceneDocument(doc).objects).toEqual([ORIGINAL]);
    history.destroy();
  });

  it('appends complete changed values and undoes an entire multi-object command in one step', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol();
    expect(applySceneCommand(doc, { type: 'create', objects: [ORIGINAL, { ...ORIGINAL, id: COPY }] }, Symbol(), true)).toEqual({ ok: true, ids: [ID, COPY] });
    const history = createSceneHistory(doc, origin);
    const record = doc.getMap('objects').get(ID) as Y.Map<unknown>;
    const initial = record.get('initial');
    const patch = { id: ID, name: 'Moved', position: [1, 2, 3] as [number, number, number], rotation: [0.5, 0.5, 0.5, 0.5] as [number, number, number, number], scale: [2, 3, 4] as [number, number, number] };
    expect(applySceneCommand(doc, { type: 'patch', patches: [patch, { id: COPY, name: 'Peer' }] }, origin, true)).toEqual({ ok: true, ids: [ID, COPY] });
    expect(readSceneDocument(doc).objects).toEqual([{ ...ORIGINAL, ...patch }, { ...ORIGINAL, id: COPY, name: 'Peer' }]);
    expect(record.get('initial')).toEqual(initial);
    for (const field of ['name', 'position', 'rotation', 'scale'] as const) {
      expect((record.get(field) as Y.Array<unknown>).toArray()).toEqual([patch[field]]);
    }
    expect((record.get('exists') as Y.Array<unknown>).toArray()).toEqual([true]);
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
    expect(applySceneCommand(doc, { type: 'create', objects: [object] }, origin, true)).toEqual({ ok: true, ids: [ID] });
    object.position[0] = 99;
    expect(readSceneDocument(doc).objects).toEqual([{ ...ORIGINAL, position: [1, 2, 3] }]);
    const position: [number, number, number] = [4, 5, 6];
    expect(applySceneCommand(doc, { type: 'patch', patches: [{ id: ID, position }] }, origin, true)).toEqual({ ok: true, ids: [ID] });
    position[0] = 88;
    expect(readSceneDocument(doc).objects).toEqual([{ ...ORIGINAL, position: [4, 5, 6] }]);
  });

  it('rejects repeated targets without appending partial patch, delete or lock records', async () => {
    const { applySceneCommand } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol();
    applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, origin, true);
    const before = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, { type: 'patch', patches: [{ id: ID, name: 'First' }, { id: ID, name: 'Second' }] }, origin, true)).toEqual({ ok: false, reason: 'invalid' });
    expect(applySceneCommand(doc, { type: 'delete', ids: [ID, ID] }, origin, true)).toEqual({ ok: false, reason: 'invalid' });
    expect(applySceneCommand(doc, { type: 'lock', ids: [ID, ID], locked: true }, origin, true)).toEqual({ ok: false, reason: 'invalid' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each(['create', 'patch', 'delete', 'lock', 'duplicate'] as const)('refuses read-only %s without writing', async (kind) => {
    const { applySceneCommand, planSceneCommand } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol();
    applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, origin, true);
    const commands = {
      create: { type: 'create', objects: [{ ...ORIGINAL, id: COPY }] },
      patch: { type: 'patch', patches: [{ id: ID, name: 'Changed' }] },
      delete: { type: 'delete', ids: [ID] }, lock: { type: 'lock', ids: [ID], locked: true },
      duplicate: { type: 'duplicate', copies: [{ sourceId: ID, id: COPY }] },
    } satisfies Record<string, Parameters<SceneModule['applySceneCommand']>[1]>;
    const before = Y.encodeStateAsUpdate(doc);
    expect(planSceneCommand(doc, commands[kind], false)).toEqual({ ok: false, reason: 'readOnly' });
    expect(applySceneCommand(doc, commands[kind], origin, false)).toEqual({ ok: false, reason: 'readOnly' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each(['patch', 'delete', 'lock', 'duplicate'] as const)('rejects a missing target in a complete %s command atomically', async (kind) => {
    const { applySceneCommand, planSceneCommand } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol();
    applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, origin, true);
    const commands = {
      patch: { type: 'patch', patches: [{ id: ID, name: 'Changed' }, { id: COPY, name: 'Missing' }] },
      delete: { type: 'delete', ids: [ID, COPY] }, lock: { type: 'lock', ids: [ID, COPY], locked: true },
      duplicate: { type: 'duplicate', copies: [{ sourceId: ID, id: THIRD }, { sourceId: COPY, id: COPY }] },
    } satisfies Record<string, Parameters<SceneModule['applySceneCommand']>[1]>;
    const before = Y.encodeStateAsUpdate(doc);
    expect(planSceneCommand(doc, commands[kind], true)).toEqual({ ok: false, reason: 'missing' });
    expect(applySceneCommand(doc, commands[kind], origin, true)).toEqual({ ok: false, reason: 'missing' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('rejects invalid multi-object creates and conflicting identities before stable records are added', async () => {
    const { applySceneCommand } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol(); const empty = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, { type: 'create', objects: [ORIGINAL, { ...ORIGINAL, id: COPY, scale: [0, 1, 1] }] }, origin, true)).toEqual({ ok: false, reason: 'invalid' });
    expect(applySceneCommand(doc, { type: 'create', objects: [ORIGINAL, ORIGINAL] }, origin, true)).toEqual({ ok: false, reason: 'duplicate' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(empty);
    applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, origin, true);
    const before = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, origin, true)).toEqual({ ok: false, reason: 'duplicate' });
    expect(applySceneCommand(doc, { type: 'duplicate', copies: [{ sourceId: ID, id: ID }] }, origin, true)).toEqual({ ok: false, reason: 'duplicate' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each([{ name: '' }, { position: [Infinity, 0, 0] }, { rotation: [0, 0, 0, 0] }, { scale: [1, -1, 1] }])(
    'rejects an invalid patch %j without applying an earlier valid target', async (invalid) => {
      const { applySceneCommand } = await loadScene();
      const doc = sceneDoc(); const origin = Symbol();
      applySceneCommand(doc, { type: 'create', objects: [ORIGINAL, { ...ORIGINAL, id: COPY }] }, origin, true);
      const before = Y.encodeStateAsUpdate(doc);
      const command = { type: 'patch', patches: [{ id: COPY, name: 'Changed' }, { id: ID, ...invalid }] } as Parameters<SceneModule['applySceneCommand']>[1];
      expect(applySceneCommand(doc, command, origin, true)).toEqual({ ok: false, reason: 'invalid' });
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    },
  );

  it('refuses locked changes to any member of a target set while preserving unlock and personal undo', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol();
    applySceneCommand(doc, { type: 'create', objects: [ORIGINAL, { ...ORIGINAL, id: COPY }] }, Symbol(), true);
    const history = createSceneHistory(doc, origin);
    applySceneCommand(doc, { type: 'patch', patches: [{ id: ID, name: 'Mine' }] }, origin, true);
    applySceneCommand(doc, { type: 'lock', ids: [ID], locked: true }, Symbol(), true);
    const before = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, { type: 'patch', patches: [{ id: COPY, position: [2, 3, 4] }, { id: ID, name: 'Blocked' }] }, origin, true)).toEqual({ ok: false, reason: 'locked' });
    expect(applySceneCommand(doc, { type: 'delete', ids: [COPY, ID] }, origin, true)).toEqual({ ok: false, reason: 'locked' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    history.undo();
    expect(readSceneDocument(doc).objects.find((object) => object.id === ID)).toEqual({ ...ORIGINAL, locked: true });
    expect(applySceneCommand(doc, { type: 'lock', ids: [ID], locked: false }, origin, true)).toEqual({ ok: true, ids: [ID] });
    expect(readSceneDocument(doc).objects).toEqual([ORIGINAL, { ...ORIGINAL, id: COPY }]);
    history.destroy();
  });

  it('duplicates a locked committed object into independent values and an unlocked new identity', async () => {
    const { applySceneCommand, readSceneDocument } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol();
    applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, origin, true);
    applySceneCommand(doc, { type: 'patch', patches: [{ id: ID, name: 'Committed', scale: [2, 3, 4] }] }, origin, true);
    applySceneCommand(doc, { type: 'lock', ids: [ID], locked: true }, origin, true);
    expect(applySceneCommand(doc, { type: 'duplicate', copies: [{ sourceId: ID, id: COPY }] }, origin, true)).toEqual({ ok: true, ids: [COPY] });
    const copy = readSceneDocument(doc).objects.find((object) => object.id === COPY);
    expect(copy).toMatchObject({ id: COPY, model: ORIGINAL.model, rotation: ORIGINAL.rotation, scale: [2, 3, 4], locked: false, exists: true });
    const sourceRecord = doc.getMap('objects').get(ID) as Y.Map<unknown>;
    const copyRecord = doc.getMap('objects').get(COPY) as Y.Map<unknown>;
    expect(copyRecord.get('initial')).not.toBe(sourceRecord.get('initial'));
    for (const field of FIELDS) expect(copyRecord.get(field)).not.toBe(sourceRecord.get(field));
    applySceneCommand(doc, { type: 'patch', patches: [{ id: COPY, name: 'Copy changed', position: [8, 9, 10] }] }, origin, true);
    expect(readSceneDocument(doc).objects.find((object) => object.id === ID)).toEqual({ ...ORIGINAL, name: 'Committed', scale: [2, 3, 4], locked: true });
    applySceneCommand(doc, { type: 'lock', ids: [ID], locked: false }, origin, true);
    applySceneCommand(doc, { type: 'patch', patches: [{ id: ID, scale: [5, 6, 7] }] }, origin, true);
    expect(readSceneDocument(doc).objects.find((object) => object.id === COPY)).toEqual({ ...copy, name: 'Copy changed', position: [8, 9, 10] });
  });

  it('preserves a hidden stable identity and refuses to duplicate or recreate it', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    const doc = sceneDoc(); const origin = Symbol();
    applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, Symbol(), true);
    const history = createSceneHistory(doc, origin);
    const record = doc.getMap('objects').get(ID);
    expect(applySceneCommand(doc, { type: 'delete', ids: [ID] }, origin, true)).toEqual({ ok: true, ids: [ID] });
    expect(readSceneDocument(doc)).toMatchObject({ status: 'ready', objects: [], invalidObjects: [] });
    expect(doc.getMap('objects').get(ID)).toBe(record);
    const before = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, { type: 'duplicate', copies: [{ sourceId: ID, id: COPY }] }, origin, true)).toEqual({ ok: false, reason: 'missing' });
    expect(applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, origin, true)).toEqual({ ok: false, reason: 'duplicate' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    history.undo(); expect(readSceneDocument(doc).objects).toEqual([ORIGINAL]);
    history.redo(); expect(readSceneDocument(doc).objects).toEqual([]);
    history.destroy();
  });

  it('preserves unknown format data and refuses commands without a write', async () => {
    const { applySceneCommand, planSceneCommand, readSceneDocument, validateSceneRecovery } = await loadScene();
    const doc = sceneDoc();
    doc.getMap('scene').set('formatVersion', 99);
    doc.getMap('objects').set(ID, { future: true });
    const before = Y.encodeStateAsUpdate(doc);
    expect(readSceneDocument(doc).status).toBe('unsupported');
    expect(planSceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, true)).toEqual({ ok: false, reason: 'unsupported' });
    expect(applySceneCommand(doc, { type: 'delete', ids: [ID] }, Symbol(), true)).toEqual({ ok: false, reason: 'unsupported' });
    expect(() => validateSceneRecovery(doc)).not.toThrow();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each(['plain-record', 'initial-exists', 'initial-lock', 'missing-sequence', 'wrong-sequence-type', 'bad-position', 'bad-rotation', 'bad-scale', 'bad-earlier-record', 'bad-boolean'])(
    'isolates a stored %s error while retaining valid neighbors and original bytes', async (damage) => {
      const { applySceneCommand, readSceneDocument, validateSceneRecovery } = await loadScene();
      const doc = sceneDoc();
      applySceneCommand(doc, { type: 'create', objects: [ORIGINAL, { ...ORIGINAL, id: COPY }] }, Symbol(), true);
      const record = doc.getMap('objects').get(ID) as Y.Map<unknown>;
      if (damage === 'plain-record') doc.getMap('objects').set(ID, { damaged: true });
      else if (damage === 'initial-exists' || damage === 'initial-lock') {
        record.set('initial', { ...(record.get('initial') as Record<string, unknown>), [damage === 'initial-exists' ? 'exists' : 'locked']: true });
      } else if (damage === 'missing-sequence') record.delete('position');
      else if (damage === 'wrong-sequence-type') record.set('position', [1, 2, 3]);
      else if (damage === 'bad-position') (record.get('position') as Y.Array<unknown>).push([[Infinity, 0, 0]]);
      else if (damage === 'bad-rotation') (record.get('rotation') as Y.Array<unknown>).push([[0, 0, 0, 0]]);
      else if (damage === 'bad-scale') (record.get('scale') as Y.Array<unknown>).push([[0, 1, 1]]);
      else if (damage === 'bad-earlier-record') (record.get('scale') as Y.Array<unknown>).push([[0, 1, 1], [1, 1, 1]]);
      else (record.get('locked') as Y.Array<unknown>).push(['yes']);
      const before = Y.encodeStateAsUpdate(doc);
      const snapshot = readSceneDocument(doc);
      expect(snapshot.status).toBe('ready');
      expect(snapshot.objects).toEqual([{ ...ORIGINAL, id: COPY }]);
      expect(snapshot.invalidObjects.map((object) => object.id)).toEqual([ID]);
      expect(() => validateSceneRecovery(doc)).not.toThrow();
      expect(applySceneCommand(doc, { type: 'patch', patches: [{ id: COPY, name: 'Neighbor' }, { id: ID, name: 'Invalid' }] }, Symbol(), true)).toEqual({ ok: false, reason: 'invalid' });
      expect(applySceneCommand(doc, { type: 'duplicate', copies: [{ sourceId: ID, id: THIRD }] }, Symbol(), true)).toEqual({ ok: false, reason: 'invalid' });
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    },
  );

  it.each(['scene', 'objects'])('retains an incompatible %s root without throwing or mutating it', async (root) => {
    const { applySceneCommand, readSceneDocument, validateSceneRecovery } = await loadScene();
    const doc = new Y.Doc(); documents.push(doc);
    doc.getText(root).insert(0, 'incompatible root');
    const before = Y.encodeStateAsUpdate(doc);
    expect(readSceneDocument(doc).status).toBe('unsupported');
    expect(applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, Symbol(), true)).toEqual({ ok: false, reason: 'unsupported' });
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
    expect(planSceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, true)).toEqual({ ok: false, reason: 'unsupported' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('refuses command application without changing its encoded bytes', async () => {
    const { applySceneCommand } = await loadScene();
    const doc = incompatibleDocument(root, shape, encoded);
    const before = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, { type: 'create', objects: [ORIGINAL] }, Symbol(), true)).toEqual({ ok: false, reason: 'unsupported' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});

describe('scene collaboration invariants with real Yjs replicas', () => {
  it('merges a legal offline patch with a peer lock and blocks new edits after that lock arrives', async () => {
    const { applySceneCommand, readSceneDocument } = await loadScene();
    const a = sceneDoc(); const oa = Symbol();
    applySceneCommand(a, { type: 'create', objects: [ORIGINAL] }, oa, true);
    const b = replica(a);
    expect(applySceneCommand(a, { type: 'patch', patches: [{ id: ID, position: [4, 5, 6] }] }, oa, true)).toEqual({ ok: true, ids: [ID] });
    expect(applySceneCommand(b, { type: 'lock', ids: [ID], locked: true }, Symbol(), true)).toEqual({ ok: true, ids: [ID] });
    merge(a, b);
    for (const doc of [a, b]) expect(readSceneDocument(doc).objects).toEqual([{ ...ORIGINAL, position: [4, 5, 6], locked: true }]);
    const before = Y.encodeStateAsUpdate(a);
    expect(applySceneCommand(a, { type: 'patch', patches: [{ id: ID, position: [7, 8, 9] }] }, oa, true)).toEqual({ ok: false, reason: 'locked' });
    expect(Y.encodeStateAsUpdate(a)).toEqual(before);
  });

  it('keeps a later peer value visible when an earlier local value is undone and redone', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    const a = sceneDoc(); const origin = Symbol();
    applySceneCommand(a, { type: 'create', objects: [ORIGINAL] }, Symbol(), true);
    const b = replica(a); const history = createSceneHistory(a, origin);
    applySceneCommand(a, { type: 'patch', patches: [{ id: ID, position: [1, 2, 3] }] }, origin, true);
    merge(a, b);
    applySceneCommand(b, { type: 'patch', patches: [{ id: ID, position: [4, 5, 6] }] }, Symbol(), true);
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
      applySceneCommand(a, { type: 'create', objects: [ORIGINAL] }, Symbol(), true);
      const b = replica(a); const leftOrder = replica(a); const rightOrder = replica(a);
      const ha = createSceneHistory(a, oa); const hb = createSceneHistory(b, ob);
      expect(applySceneCommand(a, { type: 'patch', patches: [{ id: ID, position }] }, oa, true)).toEqual({ ok: true, ids: [ID] });
      expect(applySceneCommand(b, { type: 'patch', patches: [{ id: ID, name }] }, ob, true)).toEqual({ ok: true, ids: [ID] });
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

  it('keeps same-property tuples whole, converges under reordered updates, and reveals the remaining authors tuple on undo', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    fc.assert(fc.property(fc.boolean(), fc.tuple(fc.integer(), fc.integer(), fc.integer()), fc.tuple(fc.integer(), fc.integer(), fc.integer()), (aFirst, pa, pb) => {
      const a = sceneDoc(); const oa = Symbol(); const ob = Symbol();
      applySceneCommand(a, { type: 'create', objects: [ORIGINAL] }, Symbol(), true);
      const b = replica(a); const leftOrder = replica(a); const rightOrder = replica(a);
      const ha = createSceneHistory(a, oa); const hb = createSceneHistory(b, ob);
      applySceneCommand(a, { type: 'patch', patches: [{ id: ID, position: pa }] }, oa, true);
      applySceneCommand(b, { type: 'patch', patches: [{ id: ID, position: pb }] }, ob, true);
      const ua = Y.encodeStateAsUpdate(a); const ub = Y.encodeStateAsUpdate(b);
      Y.applyUpdate(leftOrder, ua); Y.applyUpdate(leftOrder, ub);
      Y.applyUpdate(rightOrder, ub); Y.applyUpdate(rightOrder, ua); merge(a, b);
      expect(readSceneDocument(a).objects).toEqual(readSceneDocument(b).objects);
      expect(readSceneDocument(leftOrder).objects).toEqual(readSceneDocument(rightOrder).objects);
      expect(readSceneDocument(a).objects).toEqual(readSceneDocument(leftOrder).objects);
      expect([pa, pb]).toContainEqual(readSceneDocument(a).objects[0]?.position);
      const first = aFirst ? ha : hb; const second = aFirst ? hb : ha;
      first.undo(); merge(a, b);
      for (const doc of [a, b]) expect(readSceneDocument(doc).objects).toEqual([{ ...ORIGINAL, position: aFirst ? pb : pa }]);
      second.undo(); merge(a, b);
      for (const doc of [a, b]) expect(readSceneDocument(doc).objects).toEqual([ORIGINAL]);
      ha.destroy(); hb.destroy();
    }), { seed: 1704, numRuns: 40 });
  });

  it('keeps concurrent quaternion records normalized and atomic through personal undo', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    const rotations: [number, number, number, number][] = [[0, 1, 0, 0], [0.5, 0.5, 0.5, 0.5], [1, 0, 0, 0]];
    fc.assert(fc.property(fc.constantFrom(...rotations), fc.constantFrom(...rotations), (ra, rb) => {
      const a = sceneDoc(); const oa = Symbol(); const ob = Symbol();
      applySceneCommand(a, { type: 'create', objects: [ORIGINAL] }, Symbol(), true);
      const b = replica(a); const ha = createSceneHistory(a, oa); const hb = createSceneHistory(b, ob);
      applySceneCommand(a, { type: 'patch', patches: [{ id: ID, rotation: ra }] }, oa, true);
      applySceneCommand(b, { type: 'patch', patches: [{ id: ID, rotation: rb }] }, ob, true);
      merge(a, b);
      expect(readSceneDocument(a).objects).toEqual(readSceneDocument(b).objects);
      expect([ra, rb]).toContainEqual(readSceneDocument(a).objects[0]?.rotation);
      expect(readSceneDocument(a).invalidObjects).toEqual([]);
      ha.undo(); merge(a, b);
      expect(readSceneDocument(a).objects).toEqual([{ ...ORIGINAL, rotation: rb }]);
      hb.undo(); merge(a, b);
      expect(readSceneDocument(a).objects).toEqual([ORIGINAL]);
      ha.destroy(); hb.destroy();
    }), { seed: 1705, numRuns: 20 });
  });

  it('keeps a concurrent delete effective until both authors undo in either order', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    fc.assert(fc.property(fc.boolean(), (aFirst) => {
      const a = sceneDoc(); const oa = Symbol(); const ob = Symbol();
      applySceneCommand(a, { type: 'create', objects: [ORIGINAL] }, Symbol(), true);
      const b = replica(a); const ha = createSceneHistory(a, oa); const hb = createSceneHistory(b, ob);
      applySceneCommand(a, { type: 'delete', ids: [ID] }, oa, true);
      applySceneCommand(b, { type: 'delete', ids: [ID] }, ob, true); merge(a, b);
      for (const doc of [a, b]) expect(readSceneDocument(doc).objects).toEqual([]);
      (aFirst ? ha : hb).undo(); merge(a, b);
      for (const doc of [a, b]) expect(readSceneDocument(doc).objects).toEqual([]);
      (aFirst ? hb : ha).undo(); merge(a, b);
      for (const doc of [a, b]) expect(readSceneDocument(doc).objects).toEqual([ORIGINAL]);
      ha.destroy(); hb.destroy();
    }), { seed: 1706, numRuns: 10 });
  });

  it('retains late transforms on a hidden object and exposes them only after deletion undo', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    fc.assert(fc.property(fc.tuple(fc.integer(), fc.integer(), fc.integer()), (position) => {
      const a = sceneDoc(); const origin = Symbol();
      applySceneCommand(a, { type: 'create', objects: [ORIGINAL] }, Symbol(), true);
      const b = replica(a); const history = createSceneHistory(a, origin);
      applySceneCommand(a, { type: 'delete', ids: [ID] }, origin, true);
      applySceneCommand(b, { type: 'patch', patches: [{ id: ID, position }] }, Symbol(), true); merge(a, b);
      for (const doc of [a, b]) expect(readSceneDocument(doc).objects).toEqual([]);
      expect(documents.every((doc) => doc.getMap('objects').has(ID))).toBe(true);
      history.undo(); merge(a, b);
      for (const doc of [a, b]) expect(readSceneDocument(doc).objects).toEqual([{ ...ORIGINAL, position }]);
      history.destroy();
    }), { seed: 1707, numRuns: 30 });
  });

  it('retains peer edits through creation undo and prevents creation redo from overriding a peer deletion', async () => {
    const { applySceneCommand, createSceneHistory, readSceneDocument } = await loadScene();
    const a = sceneDoc(); const origin = Symbol(); const history = createSceneHistory(a, origin);
    applySceneCommand(a, { type: 'create', objects: [ORIGINAL] }, origin, true);
    const b = replica(a);
    applySceneCommand(b, { type: 'patch', patches: [{ id: ID, name: 'Peer value' }] }, Symbol(), true); merge(a, b);
    history.undo(); merge(a, b);
    expect(readSceneDocument(a).objects).toEqual([]);
    expect(documents.every((doc) => doc.getMap('objects').has(ID))).toBe(true);
    history.redo(); merge(a, b);
    expect(readSceneDocument(a).objects).toEqual([{ ...ORIGINAL, name: 'Peer value' }]);
    applySceneCommand(b, { type: 'delete', ids: [ID] }, Symbol(), true); merge(a, b);
    history.undo(); history.redo(); merge(a, b);
    for (const doc of [a, b]) expect(readSceneDocument(doc).objects).toEqual([]);
    history.destroy();
  });
});
