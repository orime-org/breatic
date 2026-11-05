// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import fc from 'fast-check';
import type * as Y from 'yjs';
import { SCENE_FORMAT_VERSION } from '@breatic/shared';
import { docName, destroyDoc, getDoc } from '@web/data/yjs/manager';
import { readSceneDocument } from '@web/data/yjs/scene-document';
import { evictSceneSession, getSceneSession, SceneSession } from '@web/data/yjs/scene-session';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';
import type { ModelSource } from '@web/spaces/three-d/model-source';
import {
  evictModelImportController, getModelImportController,
} from '@web/spaces/three-d/model-import-controller';
import type {
  ModelImportInputs, PreparedModel,
} from '@web/spaces/three-d/model-import-controller';

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const SPACE_ID = '33333333-3333-4333-8333-333333333333';
const ASSET_ID = '44444444-4444-4444-8444-444444444444';
const NEXT_ASSET_ID = '55555555-5555-4555-8555-555555555555';
const PEER_OBJECT_ID = '66666666-6666-4666-8666-666666666666';
const documents = new Map<string, Y.Doc>();

interface ImportHarness {
  doc: Y.Doc;
  name: string;
  session: SceneSession;
  inputs: ModelImportInputs;
  controller: ReturnType<typeof getModelImportController>;
  files: readonly ModelSource[];
  prepared: PreparedModel;
  prepare: Mock<ModelImportInputs['prepare']>;
  upload: Mock<ModelImportInputs['upload']>;
  position: Mock<ModelImportInputs['position']>;
}

/**
 * Supply a completed local inspection without allocating a renderer.
 * @throws {never} Never.
 */
function preparedModel(entry = 'files/character/model.glb'): PreparedModel {
  return {
    file: new File([new Uint8Array([1, 2, 3])], 'model.zip', { type: 'application/zip' }),
    entry,
    entries: [entry],
    bounds: { center: [1, 2, 3], min: [0, -1, 0] },
    dispose: vi.fn(),
  };
}

/**
 * Apply the same current editing facts that the open Space lifetime supplies.
 * @throws {never} Never directly.
 */
function setReadOnly(session: SceneSession, readOnly: boolean): void {
  session.setEnvironment({ readOnly, connected: true, hasEverSynced: true,
    writeAccess: 'granted', refused: false, awareness: null });
}

/**
 * Bind the controller to the actual document cache and personal scene session.
 * @throws {Error} When constructing a production document owner fails.
 */
function harness(): ImportHarness {
  const name = docName.threeDSpace(PROJECT_ID, SPACE_ID);
  const doc = getDoc(name);
  documents.set(name, doc);
  doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  const session = getSceneSession(doc, name);
  setReadOnly(session, false);
  const prepared = preparedModel();
  const prepare = vi.fn<ModelImportInputs['prepare']>().mockResolvedValue(prepared);
  const upload = vi.fn<ModelImportInputs['upload']>().mockResolvedValue({ assetId: ASSET_ID });
  const position = vi.fn<ModelImportInputs['position']>().mockReturnValue([4, 1, 8]);
  const inputs: ModelImportInputs = { session, prepare, upload, position };
  const controller = getModelImportController(doc, name, inputs);
  const files = [{ path: 'character.glb', file: new File([new Uint8Array([1])], 'character.glb', { type: 'model/gltf-binary' }) }];
  return { doc, name, session, inputs, controller, files, prepared, prepare, upload, position };
}

/**
 * End owners in the same explicit-cache shape as closing a Space tab.
 * @throws {never} Never directly.
 */
function release(name: string, doc: Y.Doc): void {
  evictModelImportController(name);
  evictSceneSession(name);
  destroyDoc(name, doc);
  documents.delete(name);
}

describe('document-owned model imports (inner#1690)', () => {
  afterEach(() => {
    for (const [name, doc] of [...documents]) release(name, doc);
  });

  it('retains the same prepared operation when an open document is requested again', async () => {
    const h = harness();
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'idle', prepared: null, assetId: null, error: null, progress: 0 });
    await h.controller.select(h.files, h.prepared.entry);
    h.controller.setName('My character');
    const reopened = getModelImportController(h.doc, h.name, h.inputs);

    expect(reopened).toBe(h.controller);
    expect(reopened.getSnapshot()).toMatchObject({ phase: 'ready', name: 'My character', prepared: h.prepared, assetId: null });
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(h.upload).toHaveBeenCalledTimes(0);
    expect(readSceneDocument(h.doc).objects).toEqual([]);
  });

  it('releases replaced inspection results in either completion order and places the current operation', async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async (oldCompletesFirst) => {
      const h = harness();
      try {
        const oldResult = Promise.withResolvers<PreparedModel>();
        const currentResult = Promise.withResolvers<PreparedModel>();
        const oldPrepared = preparedModel('files/old/model.glb');
        const currentPrepared = preparedModel('files/current/model.glb');
        h.prepare.mockReturnValueOnce(oldResult.promise).mockReturnValueOnce(currentResult.promise);
        const oldInspection = h.controller.select(h.files, oldPrepared.entry);
        const currentInspection = h.controller.select(h.files, currentPrepared.entry);

        expect(h.prepare.mock.calls[0][2].aborted).toBe(true);
        expect(h.prepare.mock.calls[1][2].aborted).toBe(false);
        if (oldCompletesFirst) {
          oldResult.resolve(oldPrepared);
          await Promise.allSettled([oldInspection]);
          expect(h.controller.getSnapshot().phase).toBe('checking');
          currentResult.resolve(currentPrepared);
          await currentInspection;
          h.controller.setName('Current character');
        } else {
          currentResult.resolve(currentPrepared);
          await currentInspection;
          h.controller.setName('Current character');
          oldResult.resolve(oldPrepared);
          await Promise.allSettled([oldInspection]);
        }

        expect(oldPrepared.dispose).toHaveBeenCalledTimes(1);
        expect(currentPrepared.dispose).toHaveBeenCalledTimes(0);
        expect(h.controller.getSnapshot()).toMatchObject({ phase: 'ready', name: 'Current character', prepared: currentPrepared });
        await h.controller.confirm();
        expect(h.upload.mock.calls[0][0]).toBe(currentPrepared.file);
        expect(readSceneDocument(h.doc).objects).toMatchObject([{ name: 'Current character', model: { kind: 'asset', assetId: ASSET_ID } }]);
      } finally {
        release(h.name, h.doc);
      }
    }));
  });

  it('releases the previous ready preview when another model is selected', async () => {
    const h = harness();
    const next = preparedModel('files/next/model.glb');
    h.prepare.mockResolvedValueOnce(h.prepared).mockResolvedValueOnce(next);
    await h.controller.select(h.files, h.prepared.entry);
    await h.controller.select(h.files, next.entry);

    expect(h.prepared.dispose).toHaveBeenCalledTimes(1);
    expect(next.dispose).toHaveBeenCalledTimes(0);
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'ready', prepared: next, assetId: null });
  });

  it('creates one scene object through the supplied session and supports personal undo and redo', async () => {
    const h = harness();
    await h.controller.select(h.files, h.prepared.entry);
    h.controller.setName('Imported character');
    await h.controller.confirm();
    const objects = readSceneDocument(h.doc).objects;

    expect(objects).toHaveLength(1);
    expect(objects[0]).toEqual({ id: expect.any(String), name: 'Imported character', model: { kind: 'asset', assetId: ASSET_ID },
      position: [4, 1, 8], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false });
    expect(h.position).toHaveBeenCalledWith(h.prepared.bounds);
    expect(h.session.getSnapshot().selectedIds).toEqual([objects[0].id]);
    expect(h.controller.getSnapshot().phase).toBe('placed');
    expect(h.session.history.undoStack).toHaveLength(1);
    h.session.historyStep('undo');
    expect(readSceneDocument(h.doc).objects).toEqual([]);
    h.session.historyStep('redo');
    expect(readSceneDocument(h.doc).objects).toEqual(objects);
  });

  it('keeps a peer object when the importing session undoes its own placement', async () => {
    const h = harness();
    const peer = new SceneSession(h.doc);
    setReadOnly(peer, false);
    const peerObject = { id: PEER_OBJECT_ID, name: 'Peer block', model: { kind: 'builtin' as const, id: 'box' as const },
      position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number],
      scale: [1, 1, 1] as [number, number, number], locked: false };
    try {
      expect(peer.execute({ type: 'create', objects: [peerObject] }).ok).toBe(true);
      await h.controller.select(h.files, h.prepared.entry);
      h.controller.setName('My character');
      await h.controller.confirm();
      expect(readSceneDocument(h.doc).objects).toHaveLength(2);
      h.session.historyStep('undo');
      expect(readSceneDocument(h.doc).objects).toEqual([peerObject]);
    } finally {
      peer.destroy();
    }
  });

  it('keeps repeated confirmation of one operation to one upload and one create', async () => {
    const h = harness();
    const uploaded = Promise.withResolvers<{ assetId: string }>();
    h.upload.mockReturnValue(uploaded.promise);
    await h.controller.select(h.files, h.prepared.entry);
    h.controller.setName('Single character');
    const first = h.controller.confirm();
    const repeated = h.controller.confirm();
    expect(h.controller.getSnapshot().phase).toBe('uploading');
    expect(h.upload).toHaveBeenCalledTimes(1);
    uploaded.resolve({ assetId: ASSET_ID });
    await Promise.all([first, repeated]);
    await h.controller.confirm();

    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(readSceneDocument(h.doc).objects).toHaveLength(1);
    expect(h.session.history.undoStack).toHaveLength(1);
  });

  it('publishes actual upload progress and the distinct registration phase', async () => {
    const h = harness();
    const uploaded = Promise.withResolvers<{ assetId: string }>();
    h.upload.mockImplementation((_file, _signal, onProgress) => {
      onProgress(0.5);
      return uploaded.promise;
    });
    await h.controller.select(h.files, h.prepared.entry);
    const phases: string[] = [];
    const unsubscribe = h.controller.subscribe(() => phases.push(h.controller.getSnapshot().phase));
    const confirmation = h.controller.confirm();
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'uploading', progress: 0.5 });
    h.upload.mock.calls[0][3]();
    expect(h.controller.getSnapshot().phase).toBe('registering');
    uploaded.resolve({ assetId: ASSET_ID });
    await confirmation;

    expect(h.controller.getSnapshot().phase).toBe('placed');
    expect(phases).toContain('registering');
    expect(phases.at(-1)).toBe('placed');
    unsubscribe();
    const count = phases.length;
    const next = preparedModel('files/next/model.glb');
    h.prepare.mockResolvedValueOnce(next);
    await h.controller.select(h.files, next.entry);
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'ready', prepared: next });
    expect(phases).toHaveLength(count);
  });

  it('retains the registered asset while read-only and places it after permission returns', async () => {
    const h = harness();
    const uploaded = Promise.withResolvers<{ assetId: string }>();
    h.upload.mockReturnValue(uploaded.promise);
    await h.controller.select(h.files, h.prepared.entry);
    h.controller.setName('Preserved character');
    const confirmation = h.controller.confirm();
    setReadOnly(h.session, true);
    uploaded.resolve({ assetId: ASSET_ID });
    await confirmation;

    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'ready', name: 'Preserved character', prepared: h.prepared, assetId: ASSET_ID });
    expect(readSceneDocument(h.doc).objects).toEqual([]);
    setReadOnly(h.session, false);
    await h.controller.confirm();
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(readSceneDocument(h.doc).objects).toMatchObject([{ name: 'Preserved character', model: { kind: 'asset', assetId: ASSET_ID } }]);
    expect(h.controller.getSnapshot().phase).toBe('placed');
  });

  it('aborts an evicted inspection and releases its late prepared result', async () => {
    const h = harness();
    const checked = Promise.withResolvers<PreparedModel>();
    h.prepare.mockReturnValue(checked.promise);
    const inspection = h.controller.select(h.files, h.prepared.entry);
    const signal = h.prepare.mock.calls[0][2];
    evictModelImportController(h.name);
    expect(signal.aborted).toBe(true);
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'disposed', prepared: null });
    checked.resolve(h.prepared);
    await Promise.allSettled([inspection]);

    expect(h.prepared.dispose).toHaveBeenCalledTimes(1);
    expect(readSceneDocument(h.doc).objects).toEqual([]);
    expect(h.controller.getSnapshot().phase).toBe('disposed');
  });

  it.each(['evict', 'destroyDoc'] as const)('ends upload ownership on %s and ignores late registration', async (ending) => {
    const h = harness();
    const uploaded = Promise.withResolvers<{ assetId: string }>();
    h.upload.mockReturnValue(uploaded.promise);
    await h.controller.select(h.files, h.prepared.entry);
    const confirmation = h.controller.confirm();
    const signal = h.upload.mock.calls[0][1];
    if (ending === 'evict') evictModelImportController(h.name);
    else destroyDoc(h.name, h.doc);

    expect(signal.aborted).toBe(true);
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'disposed', prepared: null });
    uploaded.resolve({ assetId: ASSET_ID });
    await Promise.allSettled([confirmation]);
    expect(readSceneDocument(h.doc).objects).toEqual([]);
    expect(h.prepared.dispose).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot().phase).toBe('disposed');
  });

  it('binds a reopened controller to a new session on the same still-live document', async () => {
    const h = harness();
    const oldUpload = Promise.withResolvers<{ assetId: string }>();
    h.upload.mockReturnValueOnce(oldUpload.promise).mockResolvedValueOnce({ assetId: NEXT_ASSET_ID });
    await h.controller.select(h.files, h.prepared.entry);
    const oldConfirmation = h.controller.confirm();
    evictSceneSession(h.name);
    evictModelImportController(h.name);
    const currentDoc = getDoc(h.name);
    const currentSession = getSceneSession(currentDoc, h.name);
    setReadOnly(currentSession, false);
    const current = getModelImportController(currentDoc, h.name, { ...h.inputs, session: currentSession });

    expect(currentDoc).toBe(h.doc);
    expect(currentSession).not.toBe(h.session);
    expect(current).not.toBe(h.controller);
    expect(current.getSnapshot().phase).toBe('idle');
    oldUpload.resolve({ assetId: ASSET_ID });
    await Promise.allSettled([oldConfirmation]);
    expect(readSceneDocument(h.doc).objects).toEqual([]);
    expect(current.getSnapshot().phase).toBe('idle');
    const next = preparedModel('files/reopened/model.glb');
    h.prepare.mockResolvedValueOnce(next);
    await current.select(h.files, next.entry);
    current.setName('Reopened character');
    await current.confirm();

    expect(readSceneDocument(h.doc).objects).toMatchObject([{ name: 'Reopened character', model: { kind: 'asset', assetId: NEXT_ASSET_ID } }]);
    expect(currentSession.history.undoStack).toHaveLength(1);
    currentSession.historyStep('undo');
    expect(readSceneDocument(h.doc).objects).toEqual([]);
  });

  it('retains prepared input and the chosen name when an upload fails, then retries that file', async () => {
    const h = harness();
    const error = new Error('Upload interrupted');
    h.upload.mockRejectedValueOnce(error).mockResolvedValueOnce({ assetId: ASSET_ID });
    await h.controller.select(h.files, h.prepared.entry);
    h.controller.setName('Retry character');
    await Promise.allSettled([h.controller.confirm()]);

    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'failed', error, prepared: h.prepared, name: 'Retry character', assetId: null });
    expect(readSceneDocument(h.doc).objects).toEqual([]);
    await h.controller.confirm();
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(h.upload).toHaveBeenCalledTimes(2);
    expect(h.upload.mock.calls.map(([file]) => file)).toEqual([h.prepared.file, h.prepared.file]);
    expect(readSceneDocument(h.doc).objects).toMatchObject([{ name: 'Retry character', model: { kind: 'asset', assetId: ASSET_ID } }]);
    expect(h.session.history.undoStack).toHaveLength(1);
  });

  it.each(['idle', 'ready', 'failed', 'placed'] as const)('clears a %s operation without deleting existing scene content', async (phase) => {
    const h = harness();
    if (phase === 'failed') h.prepare.mockRejectedValueOnce(new Error('Invalid source'));
    if (phase !== 'idle') await h.controller.select(h.files);
    if (phase === 'placed') await h.controller.confirm();
    const objects = readSceneDocument(h.doc).objects;
    h.controller.reset();

    expect(h.controller.getSnapshot()).toEqual({ phase: 'idle', name: '', progress: 0, error: null, prepared: null,
      assetId: null, objectId: null, files: [], entry: undefined, entries: [], paths: [], missing: [] });
    expect(h.prepared.dispose).toHaveBeenCalledTimes(phase === 'ready' || phase === 'placed' ? 1 : 0);
    expect(readSceneDocument(h.doc).objects).toEqual(objects);
    await h.controller.confirm();
    expect(h.upload).toHaveBeenCalledTimes(phase === 'placed' ? 1 : 0);
  });

  it('cancels checking on reset and releases a late result without restoring input', async () => {
    const h = harness();
    const pending = Promise.withResolvers<PreparedModel>();
    h.prepare.mockReturnValueOnce(pending.promise);
    const checking = h.controller.select(h.files);
    h.controller.reset();
    expect(h.prepare.mock.calls[0][2].aborted).toBe(true);
    pending.resolve(h.prepared);
    await checking;

    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'idle', files: [], prepared: null });
    expect(h.prepared.dispose).toHaveBeenCalledTimes(1);
    expect(readSceneDocument(h.doc).objects).toEqual([]);
  });

  it.each(['uploading', 'registering'] as const)('retains the confirmed operation during %s', async (phase) => {
    const h = harness();
    const pending = Promise.withResolvers<{ assetId: string }>();
    h.upload.mockReturnValueOnce(pending.promise);
    await h.controller.select(h.files);
    const confirmation = h.controller.confirm();
    if (phase === 'registering') h.upload.mock.calls[0][3]();
    const before = h.controller.getSnapshot();
    h.controller.reset();
    await h.controller.select([{ path: 'next.glb', file: new File(['next'], 'next.glb') }]);
    expect(h.controller.getSnapshot()).toBe(before);
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(h.prepared.dispose).not.toHaveBeenCalled();
    pending.resolve({ assetId: ASSET_ID });
    await confirmation;
    expect(readSceneDocument(h.doc).objects).toHaveLength(1);
  });

  it('ignores state changes and old callbacks after disposal', async () => {
    const h = harness();
    const pending = Promise.withResolvers<{ assetId: string }>();
    h.upload.mockReturnValueOnce(pending.promise);
    await h.controller.select(h.files);
    const confirmation = h.controller.confirm();
    h.controller.dispose();
    const before = h.controller.getSnapshot();
    h.controller.dispose();
    h.controller.reset();
    h.controller.setName('Late rename');
    h.upload.mock.calls[0][2](0.8);
    h.upload.mock.calls[0][3]();
    await h.controller.select(h.files);
    pending.reject('Late upload error');
    await confirmation;
    await h.controller.confirm();

    expect(h.controller.getSnapshot()).toBe(before);
    expect(h.prepared.dispose).toHaveBeenCalledTimes(1);
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(readSceneDocument(h.doc).objects).toEqual([]);
  });

  it('does not restore an error from a superseded inspection', async () => {
    const h = harness();
    const pending = Promise.withResolvers<PreparedModel>();
    h.prepare.mockReturnValueOnce(pending.promise);
    const inspection = h.controller.select(h.files);
    h.controller.reset();
    pending.reject(new Error('Late inspection failure'));
    await inspection;
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'idle', error: null, prepared: null });
  });

  it('retains registered bytes for a refused scene command and retries placement without uploading', async () => {
    const h = harness();
    await h.controller.select(h.files);
    h.controller.setName('');
    await h.controller.confirm();
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'failed', assetId: ASSET_ID,
      error: { name: 'ModelImportError', code: 'invalid' } });
    expect(readSceneDocument(h.doc).objects).toEqual([]);
    h.controller.setName('Valid character');
    await h.controller.confirm();
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(readSceneDocument(h.doc).objects).toMatchObject([{ name: 'Valid character', model: { kind: 'asset', assetId: ASSET_ID } }]);
  });

  it('does not create an object when publishing registration closes its document owner', async () => {
    const h = harness();
    await h.controller.select(h.files);
    h.controller.subscribe(() => {
      if (h.controller.getSnapshot().assetId !== null) h.controller.dispose();
    });
    await h.controller.confirm();
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'disposed', assetId: ASSET_ID });
    expect(h.prepared.dispose).toHaveBeenCalledTimes(1);
    expect(readSceneDocument(h.doc).objects).toEqual([]);
  });

  it('normalizes non-Error failures and preserves typed inspection choices', async () => {
    const h = harness();
    h.prepare.mockRejectedValueOnce('Invalid source');
    await h.controller.select(h.files);
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'failed', error: { message: 'Invalid source' } });
    const info = { paths: ['one.glb', 'two.glb'], entries: ['one.glb', 'two.glb'], missing: [] };
    h.prepare.mockRejectedValueOnce(new ModelImportError('entry', 'Choose an entry', { detail: '', info }));
    await h.controller.select(h.files);
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'failed', ...info, error: { code: 'entry' } });
    h.upload.mockRejectedValueOnce('Upload interrupted');
    await h.controller.select(h.files);
    await h.controller.confirm();
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'failed', error: { message: 'Upload interrupted' } });
  });

  it('clears a previous name when another collection is selected', async () => {
    const h = harness();
    await h.controller.select(h.files);
    h.controller.setName('Prepared character');
    const info = { paths: ['one.glb', 'two.glb'], entries: ['one.glb', 'two.glb'], missing: [] };
    h.prepare.mockRejectedValueOnce(new ModelImportError('entry', 'Choose an entry', { detail: '', info }));
    await h.controller.select([...h.files]);
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'failed', name: '', entry: undefined });
  });

  it('shows the main file and its default name while resources are missing, and keeps a typed name through the supplement', async () => {
    const h = harness();
    const info = { entry: 'files/scene.gltf', paths: ['files/scene.gltf'], entries: ['files/scene.gltf'], missing: ['files/mesh.bin'] };
    h.prepare.mockRejectedValueOnce(new ModelImportError('missing', 'Missing model resources', { detail: '', info }))
      .mockResolvedValueOnce(preparedModel('files/scene.gltf'));
    await h.controller.select(h.files);
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'failed', entry: 'files/scene.gltf', name: 'scene' });
    h.controller.setName('Hero');
    const added = [{ path: 'files/mesh.bin', file: new File([new Uint8Array([2])], 'mesh.bin') }];
    await h.controller.supplement(added);
    expect(h.prepare).toHaveBeenLastCalledWith([...h.files, ...added], 'files/scene.gltf', expect.any(AbortSignal));
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'ready', name: 'Hero' });
  });

  it('follows the chosen main file with the default name until a name is typed', async () => {
    const h = harness();
    h.prepare.mockResolvedValueOnce(preparedModel('one.glb')).mockResolvedValueOnce(preparedModel('two.glb')).mockResolvedValueOnce(preparedModel('one.glb'));
    await h.controller.select(h.files, 'one.glb');
    expect(h.controller.getSnapshot().name).toBe('one');
    await h.controller.select(h.controller.getSnapshot().files, 'two.glb');
    expect(h.controller.getSnapshot().name).toBe('two');
    h.controller.setName('Chosen');
    await h.controller.select(h.controller.getSnapshot().files, 'one.glb');
    expect(h.controller.getSnapshot().name).toBe('Chosen');
  });

  it('records an inspection failure and accepts replacement input before upload', async () => {
    const h = harness();
    const error = new Error('Missing geometry.bin');
    h.prepare.mockRejectedValueOnce(error).mockResolvedValueOnce(h.prepared);
    await Promise.allSettled([h.controller.select(h.files, h.prepared.entry)]);
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'failed', error, prepared: null, assetId: null });
    expect(h.upload).toHaveBeenCalledTimes(0);
    expect(readSceneDocument(h.doc).objects).toEqual([]);
    await h.controller.select(h.files, h.prepared.entry);
    h.controller.setName('Recovered character');
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'ready', error: null, prepared: h.prepared });
    await h.controller.confirm();

    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(readSceneDocument(h.doc).objects).toMatchObject([{ name: 'Recovered character', model: { kind: 'asset', assetId: ASSET_ID } }]);
  });
});
