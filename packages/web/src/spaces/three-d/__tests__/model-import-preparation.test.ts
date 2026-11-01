// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { inspectModelSelectionInWorker, prepareSceneModel } from '@web/spaces/three-d/model-import-preparation';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';
import { serializeModelImportError } from '@web/spaces/three-d/model-import-worker-protocol';
import type { ModelImportWorkerAnswer } from '@web/spaces/three-d/model-import-worker-protocol';
import type { ModelSelection } from '@web/spaces/three-d/model-selection';

/** A controlled transport retains callbacks that may already be queued. */
const parse = vi.hoisted(() => vi.fn());
vi.mock('@web/spaces/three-d/viewport/model-resources', async (importOriginal) => ({
  ...await importOriginal<typeof import('@web/spaces/three-d/viewport/model-resources')>(), parseSceneModel: parse,
}));
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  /** Stand in for a WebGL renderer, which jsdom cannot create. */
  class TestRenderer {
    readonly capabilities = { maxTextureSize: 8192 };
    /** @returns Nothing. @throws {never} Never. */
    setSize(): void {}
    /** @returns Nothing. @throws {never} Never. */
    dispose(): void {}
    /** @returns Nothing. @throws {never} Never. */
    forceContextLoss(): void {}
  }
  return { ...actual, WebGLRenderer: TestRenderer };
});

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  static constructorError: unknown;
  static postError: unknown;
  static onConstruct: (() => void) | undefined;
  onmessage: ((event: MessageEvent<ModelImportWorkerAnswer>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly postMessage = vi.fn(() => { if (ControlledWorker.postError !== undefined) throw ControlledWorker.postError; });
  readonly terminate = vi.fn();

  /**
   * Record the worker constructed by the production adapter.
   * @throws {unknown} When the test injects a construction failure.
   */
  constructor() {
    if (ControlledWorker.constructorError !== undefined) throw ControlledWorker.constructorError;
    ControlledWorker.instances.push(this);
    ControlledWorker.onConstruct?.();
  }
}

const FILES = [{ path: 'model.gltf', file: new File(['model source'], 'model.gltf') }];
const SELECTION: ModelSelection = { model: { entry: 'model.gltf', files: new Map(), json: { asset: { version: '2.0' } } },
  artifact: new Uint8Array([1]), entries: ['model.gltf'], paths: ['model.gltf'] };

beforeEach(() => {
  ControlledWorker.instances = [];
  ControlledWorker.constructorError = undefined;
  ControlledWorker.postError = undefined;
  ControlledWorker.onConstruct = undefined;
  vi.stubGlobal('Worker', ControlledWorker);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('operation-owned model inspection worker', () => {
  it('refuses a cancelled operation before creating a worker', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(inspectModelSelectionInWorker(FILES, undefined, abort.signal, IMPORT_LIMITS)).rejects.toMatchObject({ name: 'AbortError' });
    expect(ControlledWorker.instances).toHaveLength(0);
  });

  it('transfers the selected entry and configured budgets, then releases its worker', async () => {
    const abort = new AbortController();
    const running = inspectModelSelectionInWorker(FILES, 'model.gltf', abort.signal, IMPORT_LIMITS);
    const worker = ControlledWorker.instances[0];
    const reply = worker.onmessage;
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({ files: FILES, entry: 'model.gltf', limits: IMPORT_LIMITS });
    reply?.(new MessageEvent('message', { data: { ok: true, selection: SELECTION } }));
    await expect(running).resolves.toBe(SELECTION);
    abort.abort();
    reply?.(new MessageEvent('message', { data: { ok: true, selection: SELECTION } }));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    expect(worker.onmessageerror).toBeNull();
  });

  it('retains error paths and entry choices across the worker boundary', async () => {
    const info = { entries: ['one.glb', 'two.glb'], paths: ['one.glb', 'two.glb'], missing: [] };
    const failure = new ModelImportError('entry', 'Choose a model entry', info, 'one.glb');
    const running = inspectModelSelectionInWorker(FILES, undefined, new AbortController().signal, IMPORT_LIMITS);
    const worker = ControlledWorker.instances[0];
    worker.onmessage?.(new MessageEvent('message', { data: { ok: false, error: serializeModelImportError(failure) } }));
    await expect(running).rejects.toMatchObject({ name: 'ModelImportError', code: 'entry', info, detail: 'one.glb' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('keeps entry choices on a model refused while it is parsed', async () => {
    parse.mockRejectedValueOnce(new ModelImportError('budget', 'Model textures exceed the configured cumulative budget'));
    const running = prepareSceneModel(FILES, undefined, new AbortController().signal, IMPORT_LIMITS);
    await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1));
    ControlledWorker.instances[0].onmessage?.(new MessageEvent('message', { data: { ok: true, selection: SELECTION } }));
    await expect(running).rejects.toMatchObject({ code: 'budget', info: { entries: SELECTION.entries, paths: SELECTION.paths, missing: [] } });
  });

  it('cancels one worker without affecting another operation or accepting its late reply', async () => {
    const first = new AbortController();
    const cancelled = inspectModelSelectionInWorker(FILES, undefined, first.signal, IMPORT_LIMITS);
    const retained = inspectModelSelectionInWorker(FILES, undefined, new AbortController().signal, IMPORT_LIMITS);
    const [oldWorker, currentWorker] = ControlledWorker.instances;
    const lateReply = oldWorker.onmessage;
    first.abort();
    lateReply?.(new MessageEvent('message', { data: { ok: true, selection: SELECTION } }));
    currentWorker.onmessage?.(new MessageEvent('message', { data: { ok: true, selection: SELECTION } }));
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await expect(retained).resolves.toBe(SELECTION);
    expect(oldWorker.terminate).toHaveBeenCalledTimes(1);
    expect(currentWorker.terminate).toHaveBeenCalledTimes(1);
  });

  it('handles cancellation during construction before posting any input', async () => {
    const abort = new AbortController();
    ControlledWorker.onConstruct = () => abort.abort();
    await expect(inspectModelSelectionInWorker(FILES, undefined, abort.signal, IMPORT_LIMITS)).rejects.toMatchObject({ name: 'AbortError' });
    expect(ControlledWorker.instances[0].postMessage).not.toHaveBeenCalled();
    expect(ControlledWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  });

  it.each([new Error('Worker unavailable'), 'Worker unavailable'])('normalizes construction failure %s', async (error) => {
    ControlledWorker.constructorError = error;
    await expect(inspectModelSelectionInWorker(FILES, undefined, new AbortController().signal, IMPORT_LIMITS))
      .rejects.toMatchObject({ name: 'ModelImportError', code: 'invalid', message: 'Worker unavailable' });
    expect(ControlledWorker.instances).toHaveLength(0);
  });

  it.each([new Error('Input cannot be cloned'), 'Input cannot be cloned'])('releases a worker after postMessage failure %s', async (error) => {
    ControlledWorker.postError = error;
    await expect(inspectModelSelectionInWorker(FILES, undefined, new AbortController().signal, IMPORT_LIMITS))
      .rejects.toMatchObject({ name: 'ModelImportError', code: 'invalid', message: 'Input cannot be cloned' });
    expect(ControlledWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'messageerror'] as const)('releases its worker on %s', async (type) => {
    const running = inspectModelSelectionInWorker(FILES, undefined, new AbortController().signal, IMPORT_LIMITS);
    const worker = ControlledWorker.instances[0];
    const event = new ErrorEvent('error', { message: 'Worker failed', cancelable: true });
    if (type === 'error') worker.onerror?.(event);
    else worker.onmessageerror?.();
    await expect(running).rejects.toMatchObject({ name: 'ModelImportError', code: 'invalid',
      message: type === 'error' ? 'Worker failed' : 'Model inspection result could not be read' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    if (type === 'error') expect(event.defaultPrevented).toBe(true);
  });

  it.each([new Error('Inspection failed'), 'Inspection failed'])('serializes an untyped worker failure %s', (error) => {
    expect(serializeModelImportError(error)).toEqual({ code: 'invalid', message: 'Inspection failed', detail: '' });
  });
});
