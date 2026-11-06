// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import fc from 'fast-check';
import type * as Y from 'yjs';
import { docName, destroyDoc, getDoc } from '@web/data/yjs/manager';
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
const TASK_ID = '44444444-4444-4444-8444-444444444444';
const documents = new Map<string, Y.Doc>();

interface ImportHarness {
  doc: Y.Doc;
  name: string;
  inputs: ModelImportInputs;
  controller: ReturnType<typeof getModelImportController>;
  files: readonly ModelSource[];
  prepared: PreparedModel;
  prepare: Mock<ModelImportInputs['prepare']>;
  start: Mock<ModelImportInputs['start']>;
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
 * Bind the controller to the actual document cache and personal scene session.
 * @throws {Error} When constructing a production document owner fails.
 */
function harness(): ImportHarness {
  const name = docName.threeDSpace(PROJECT_ID, SPACE_ID);
  const doc = getDoc(name);
  documents.set(name, doc);
  const prepared = preparedModel();
  const prepare = vi.fn<ModelImportInputs['prepare']>().mockResolvedValue(prepared);
  const start = vi.fn<ModelImportInputs['start']>().mockResolvedValue({ kind: 'opened', taskId: TASK_ID });
  const inputs: ModelImportInputs = { prepare, start };
  const controller = getModelImportController(doc, name, inputs);
  const files = [{ path: 'character.glb', file: new File([new Uint8Array([1])], 'character.glb', { type: 'model/gltf-binary' }) }];
  return { doc, name, inputs, controller, files, prepared, prepare, start };
}

/**
 * End owners in the same explicit-cache shape as closing a Space tab.
 * @throws {never} Never directly.
 */
function release(name: string, doc: Y.Doc): void {
  evictModelImportController(name);
  destroyDoc(name, doc);
  documents.delete(name);
}

describe('document-owned model imports (inner#1690)', () => {
  afterEach(() => {
    for (const [name, doc] of [...documents]) release(name, doc);
  });

  it('retains the same prepared operation when an open document is requested again', async () => {
    const h = harness();
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'idle', prepared: null, error: null });
    await h.controller.select(h.files, h.prepared.entry);
    h.controller.setName('My character');
    const reopened = getModelImportController(h.doc, h.name, h.inputs);

    expect(reopened).toBe(h.controller);
    expect(reopened.getSnapshot()).toMatchObject({ phase: 'ready', name: 'My character', prepared: h.prepared });
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(h.start).toHaveBeenCalledTimes(0);
  });

  it('releases the previous ready preview when another model is selected', async () => {
    const h = harness();
    const next = preparedModel('files/next/model.glb');
    h.prepare.mockResolvedValueOnce(h.prepared).mockResolvedValueOnce(next);
    await h.controller.select(h.files, h.prepared.entry);
    await h.controller.select(h.files, next.entry);

    expect(h.prepared.dispose).toHaveBeenCalledTimes(1);
    expect(next.dispose).toHaveBeenCalledTimes(0);
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'ready', prepared: next });
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
    expect(h.controller.getSnapshot().phase).toBe('disposed');
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

  it('normalizes non-Error failures and preserves typed inspection choices', async () => {
    const h = harness();
    h.prepare.mockRejectedValueOnce('Invalid source');
    await h.controller.select(h.files);
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'failed', error: { message: 'Invalid source' } });
    const info = { paths: ['one.glb', 'two.glb'], entries: ['one.glb', 'two.glb'], missing: [] };
    h.prepare.mockRejectedValueOnce(new ModelImportError('entry', 'Choose an entry', { detail: '', info }));
    await h.controller.select(h.files);
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'failed', ...info, error: { code: 'entry' } });
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


  it('starts the upload under the shown name, then returns to idle with the new row', async () => {
    const h = harness();
    await h.controller.select(h.files, h.prepared.entry);
    h.controller.setName('Barn lamp');
    const pending = Promise.withResolvers<Awaited<ReturnType<ModelImportInputs['start']>>>();
    h.start.mockReturnValueOnce(pending.promise);
    const confirmation = h.controller.confirm();
    expect(h.controller.getSnapshot().phase).toBe('starting');
    expect(h.start).toHaveBeenCalledWith(h.prepared.file, 'Barn lamp');
    pending.resolve({ kind: 'opened', taskId: TASK_ID });

    await expect(confirmation).resolves.toBe(TASK_ID);
    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'idle', prepared: null, name: '', files: [] });
    expect(h.prepared.dispose).toHaveBeenCalledTimes(1);
  });

  it('starts one upload however often it is confirmed while starting', async () => {
    const h = harness();
    await h.controller.select(h.files);
    const pending = Promise.withResolvers<Awaited<ReturnType<ModelImportInputs['start']>>>();
    h.start.mockReturnValueOnce(pending.promise);
    const first = h.controller.confirm();
    const repeated = h.controller.confirm();
    pending.resolve({ kind: 'opened', taskId: TASK_ID });
    await expect(Promise.all([first, repeated])).resolves.toEqual([TASK_ID, TASK_ID]);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('keeps the checked file and name when the upload cannot start, and starts again', async () => {
    const h = harness();
    await h.controller.select(h.files);
    h.controller.setName('Retry character');
    h.start.mockResolvedValueOnce({ kind: 'refused', reason: 'storage' });
    await expect(h.controller.confirm()).resolves.toBeNull();

    expect(h.controller.getSnapshot()).toMatchObject({ phase: 'failed', prepared: h.prepared, name: 'Retry character',
      error: { name: 'UploadFailedError', reason: 'storage' } });
    expect(h.prepared.dispose).not.toHaveBeenCalled();
    await expect(h.controller.confirm()).resolves.toBe(TASK_ID);
    expect(h.start.mock.calls.map(([file]) => file)).toEqual([h.prepared.file, h.prepared.file]);
  });

  it('ignores new input and reset while starting', async () => {
    const h = harness();
    await h.controller.select(h.files);
    const pending = Promise.withResolvers<Awaited<ReturnType<ModelImportInputs['start']>>>();
    h.start.mockReturnValueOnce(pending.promise);
    const confirmation = h.controller.confirm();
    const before = h.controller.getSnapshot();
    h.controller.reset();
    h.controller.setName('Changed');
    await h.controller.select([{ path: 'next.glb', file: new File(['next'], 'next.glb') }]);
    await h.controller.supplement([{ path: 'more.bin', file: new File(['more'], 'more.bin') }]);

    expect(h.controller.getSnapshot()).toBe(before);
    expect(h.prepare).toHaveBeenCalledTimes(1);
    pending.resolve({ kind: 'opened', taskId: TASK_ID });
    await confirmation;
  });

  it.each(['ready', 'failed'] as const)('clears a %s operation', async (phase) => {
    const h = harness();
    if (phase === 'failed') h.prepare.mockRejectedValueOnce(new Error('Invalid source'));
    await h.controller.select(h.files);
    h.controller.reset();

    expect(h.controller.getSnapshot()).toEqual({ phase: 'idle', name: '', error: null, prepared: null,
      files: [], entry: undefined, entries: [], paths: [], missing: [] });
    expect(h.prepared.dispose).toHaveBeenCalledTimes(phase === 'ready' ? 1 : 0);
    await expect(h.controller.confirm()).resolves.toBeNull();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('ignores the answer that arrives after its document closed; the upload goes on without it', async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom('evict', 'destroyDoc'), async (ending) => {
      const h = harness();
      try {
        await h.controller.select(h.files);
        const pending = Promise.withResolvers<Awaited<ReturnType<ModelImportInputs['start']>>>();
        h.start.mockReturnValueOnce(pending.promise);
        const confirmation = h.controller.confirm();
        if (ending === 'evict') evictModelImportController(h.name);
        else destroyDoc(h.name, h.doc);
        const disposed = h.controller.getSnapshot();
        pending.resolve({ kind: 'opened', taskId: TASK_ID });
        await confirmation;
        expect(h.controller.getSnapshot()).toBe(disposed);
        expect(disposed.phase).toBe('disposed');
        expect(h.prepared.dispose).toHaveBeenCalledTimes(1);
      } finally {
        release(h.name, h.doc);
      }
    }));
  });

});
