// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Bone, BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial, Skeleton, SkinnedMesh } from 'three';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { prepareSceneModel } from '@web/spaces/three-d/model-import-preparation';
import { inspectModelSelectionInWorker, readRegisteredModelPackageInWorker } from '@web/spaces/three-d/model-import-worker-client';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';
import { serializeWorkerError } from '@web/spaces/three-d/model-import-worker-protocol';
import type { ModelImportWorkerAnswer } from '@web/spaces/three-d/model-import-worker-protocol';
import type { ModelSelection } from '@web/spaces/three-d/model-selection';

/** A controlled transport retains callbacks that may already be queued. */
const parse = vi.hoisted(() => vi.fn());
// jsdom never decodes the format probe images; this browser decodes WebP and not AVIF.
vi.mock('@web/spaces/three-d/model-texture-format', () => ({ detectTextureFormatSupport: vi.fn(async () => ({ webp: true, avif: false })) }));
/** The preview context the stand-in renderer reports after a render. */
const gl = vi.hoisted(() => ({ lost: false, error: 0, renderError: undefined as Error | undefined }));
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
    /** @returns Nothing. @throws {Error} The render failure the test set. */
    render(): void { if (gl.renderError) throw gl.renderError; }
    /** @returns The preview context state the test set. @throws {never} Never. */
    getContext(): { NO_ERROR: number; isContextLost: () => boolean; getError: () => number } {
      return { NO_ERROR: 0, isContextLost: () => gl.lost, getError: () => gl.error };
    }
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
const SELECTION: ModelSelection = { model: { entry: 'model.gltf', files: new Map(), json: { asset: { version: '2.0' } }, support: { webp: true, avif: false } },
  artifact: new Uint8Array([1]), entries: ['model.gltf'], paths: ['model.gltf'] };

beforeEach(() => {
  ControlledWorker.instances = [];
  ControlledWorker.constructorError = undefined;
  ControlledWorker.postError = undefined;
  ControlledWorker.onConstruct = undefined;
  vi.stubGlobal('Worker', ControlledWorker);
});
afterEach(() => { vi.unstubAllGlobals(); gl.lost = false; gl.error = 0; gl.renderError = undefined; });

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
    await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1));
    const worker = ControlledWorker.instances[0];
    const reply = worker.onmessage;
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({ kind: 'selection', files: FILES, entry: 'model.gltf', limits: IMPORT_LIMITS, support: { webp: true, avif: false } }, []);
    reply?.(new MessageEvent('message', { data: { ok: true, selection: SELECTION } }));
    await expect(running).resolves.toBe(SELECTION);
    abort.abort();
    reply?.(new MessageEvent('message', { data: { ok: true, selection: SELECTION } }));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    expect(worker.onmessageerror).toBeNull();
  });

  it('unpacks a registered package in a worker and terminates it when the model lease ends', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const lease = new AbortController();
    const running = readRegisteredModelPackageInWorker(bytes, lease.signal, IMPORT_LIMITS);
    await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1));
    const worker = ControlledWorker.instances[0];
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({ kind: 'registered', bytes, limits: IMPORT_LIMITS, support: { webp: true, avif: false } }, [bytes.buffer]);
    lease.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('carries an exceeded limit across the worker boundary', async () => {
    const budget = { limit: 'expanded', allowed: 1000, actual: 2000 } as const;
    const failure = new ModelImportError('budget', 'Model archive exceeds its expanded-byte budget', { detail: '', budget });
    const running = inspectModelSelectionInWorker(FILES, undefined, new AbortController().signal, IMPORT_LIMITS);
    await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1));
    ControlledWorker.instances[0].onmessage?.(new MessageEvent('message', { data: { ok: false, error: serializeWorkerError(failure) } }));
    await expect(running).rejects.toMatchObject({ code: 'budget', budget });
  });

  it('retains error paths and entry choices across the worker boundary', async () => {
    const info = { entries: ['one.glb', 'two.glb'], paths: ['one.glb', 'two.glb'], missing: [] };
    const failure = new ModelImportError('entry', 'Choose a model entry', { detail: 'one.glb', info });
    const running = inspectModelSelectionInWorker(FILES, undefined, new AbortController().signal, IMPORT_LIMITS);
    await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1));
    const worker = ControlledWorker.instances[0];
    worker.onmessage?.(new MessageEvent('message', { data: { ok: false, error: serializeWorkerError(failure) } }));
    await expect(running).rejects.toMatchObject({ name: 'ModelImportError', code: 'entry', info, detail: 'one.glb' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('keeps entry choices and the main file on a model refused while it is parsed', async () => {
    parse.mockRejectedValueOnce(new ModelImportError('budget', 'Model textures exceed the configured cumulative budget', { detail: '',
      budget: { limit: 'textureBytes', allowed: 10, actual: 20 } }));
    const running = prepareSceneModel(FILES, undefined, new AbortController().signal, IMPORT_LIMITS);
    await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1));
    ControlledWorker.instances[0].onmessage?.(new MessageEvent('message', { data: { ok: true, selection: SELECTION } }));
    await expect(running).rejects.toMatchObject({ code: 'budget', budget: { limit: 'textureBytes', allowed: 10, actual: 20 },
      info: { entry: SELECTION.model.entry, entries: SELECTION.entries, paths: SELECTION.paths, missing: [] } });
  });

  it('cancels one worker without affecting another operation or accepting its late reply', async () => {
    const first = new AbortController();
    const cancelled = inspectModelSelectionInWorker(FILES, undefined, first.signal, IMPORT_LIMITS);
    const retained = inspectModelSelectionInWorker(FILES, undefined, new AbortController().signal, IMPORT_LIMITS);
    await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(2));
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
      .rejects.toMatchObject({ name: 'Error', message: 'Worker unavailable' });
    expect(ControlledWorker.instances).toHaveLength(0);
  });

  it.each([new Error('Input cannot be cloned'), 'Input cannot be cloned'])('releases a worker after postMessage failure %s', async (error) => {
    ControlledWorker.postError = error;
    await expect(inspectModelSelectionInWorker(FILES, undefined, new AbortController().signal, IMPORT_LIMITS))
      .rejects.toMatchObject({ name: 'Error', message: 'Input cannot be cloned' });
    expect(ControlledWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'messageerror'] as const)('releases its worker on %s', async (type) => {
    const running = inspectModelSelectionInWorker(FILES, undefined, new AbortController().signal, IMPORT_LIMITS);
    await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1));
    const worker = ControlledWorker.instances[0];
    const event = new ErrorEvent('error', { message: 'Worker failed', cancelable: true });
    if (type === 'error') worker.onerror?.(event);
    else worker.onmessageerror?.();
    await expect(running).rejects.toMatchObject({ name: 'Error',
      message: type === 'error' ? 'Worker failed' : 'Model inspection result could not be read' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    if (type === 'error') expect(event.defaultPrevented).toBe(true);
  });

  it.each([new Error('Inspection failed'), 'Inspection failed'])('carries a failure thrown inside the worker %s as a content verdict', async (error) => {
    const running = inspectModelSelectionInWorker(FILES, undefined, new AbortController().signal, IMPORT_LIMITS);
    await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1));
    ControlledWorker.instances[0].onmessage?.(new MessageEvent('message', { data: { ok: false, error: serializeWorkerError(error) } }));
    await expect(running).rejects.toMatchObject({ name: 'ModelImportError', code: 'invalid', message: 'Inspection failed' });
  });

  it('keeps a preview failure that is not about the model content a plain error', async () => {
    parse.mockRejectedValueOnce(new Error('Decoder could not be fetched'));
    const running = prepareSceneModel(FILES, undefined, new AbortController().signal, IMPORT_LIMITS);
    await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1));
    ControlledWorker.instances[0].onmessage?.(new MessageEvent('message', { data: { ok: true, selection: SELECTION } }));
    await expect(running).rejects.toMatchObject({ name: 'Error', message: 'Decoder could not be fetched' });
  });
});


describe('preview failures are classified by stage (inner#1690)', () => {
  /**
   * Prepare the fixed selection with a parsed template, returning the preparation's outcome.
   * @throws {never} Never; the outcome carries any failure.
   */
  async function prepareWith(root: Group): Promise<unknown> {
    parse.mockResolvedValueOnce(root);
    const running = prepareSceneModel(FILES, undefined, new AbortController().signal, IMPORT_LIMITS);
    await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1));
    ControlledWorker.instances[0].onmessage?.(new MessageEvent('message', { data: { ok: true, selection: SELECTION } }));
    return running.then((prepared) => { prepared.dispose(); return prepared; }, (error: unknown) => error);
  }

  /**
   * Build a template holding one triangle.
   * @throws {never} Never.
   */
  function triangle(): Group {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    return new Group().add(new Mesh(geometry, new MeshBasicMaterial()));
  }

  it('refuses a model whose skin names a joint it does not have as content, with its entry choices', async () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array([5, 0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0]), 4));
    geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4));
    const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
    const bone = new Bone();
    mesh.add(bone);
    mesh.bind(new Skeleton([bone]));
    expect(await prepareWith(new Group().add(mesh))).toMatchObject({ name: 'ModelImportError', code: 'invalid', info: { entries: SELECTION.entries } });
  });

  it('refuses a mesh without finite geometry before upload', async () => {
    expect(await prepareWith(new Group().add(new Mesh(new BufferGeometry(), new MeshBasicMaterial())))).toMatchObject({ name: 'ModelImportError', code: 'empty' });
  });

  it('refuses a preview the GPU reports an error for as content', async () => {
    gl.error = 0x0502;
    expect(await prepareWith(triangle())).toMatchObject({ name: 'ModelImportError', code: 'invalid' });
  });

  it('keeps a GPU context lost in the middle of rendering a plain, retryable error', async () => {
    gl.lost = true;
    gl.renderError = new TypeError('Cannot read properties of null (reading trim)');
    expect(await prepareWith(triangle())).toMatchObject({ name: 'TypeError' });
  });

  it('keeps a lost GPU context a plain, retryable error', async () => {
    gl.lost = true;
    expect(await prepareWith(triangle())).toMatchObject({ name: 'Error' });
  });

  it('accepts a finite triangle', async () => {
    expect(await prepareWith(triangle())).toMatchObject({ meshCount: 1 });
  });
});
