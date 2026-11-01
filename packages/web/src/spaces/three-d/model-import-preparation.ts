// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Box3, DirectionalLight, HemisphereLight, Mesh, PerspectiveCamera, Scene, SkinnedMesh, Vector3, WebGLRenderer } from 'three';
import type { Group } from 'three';
import type { SceneImportLimits } from '@breatic/shared';
import type { PreparedModel } from '@web/spaces/three-d/model-import-controller';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';
import { deserializeModelImportError } from '@web/spaces/three-d/model-import-worker-protocol';
import type { ModelImportWorkerAnswer, ModelImportWorkerRequest } from '@web/spaces/three-d/model-import-worker-protocol';
import type { ModelSelection } from '@web/spaces/three-d/model-selection';
import type { ModelSource } from '@web/spaces/three-d/model-source';
import { getUnsupportedModelExtensions } from '@web/spaces/three-d/viewport/model-decoder-173';
import { disposeModelTemplate, parseSceneModel } from '@web/spaces/three-d/viewport/model-resources';

/**
 * Inspect one original file collection in its own cancellable worker.
 * @param files - Original files under their paths in the user's collection.
 * @param entry - Explicit selected entry when the collection contains several models.
 * @param signal - Owning import operation's cancellation signal.
 * @param limits - Project's import budgets.
 * @returns Checked resources and the deterministic registered artifact.
 * @throws {DOMException} When the owning operation is aborted.
 * @throws {ModelImportError} When worker setup, execution or inspection fails.
 */
export function inspectModelSelectionInWorker(files: readonly ModelSource[], entry: string | undefined, signal: AbortSignal, limits: SceneImportLimits): Promise<ModelSelection> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Model inspection cancelled', 'AbortError')); return; }
    let worker: Worker;
    try {
      worker = new Worker(new URL('./model-import-worker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      reject(new ModelImportError('invalid', error instanceof Error ? error.message : String(error), { detail: '' }));
      return;
    }
    let settled = false;
    /**
     * End this worker exactly once before delivering its terminal result.
     * @param action - Resolves or rejects the waiting operation.
     * @throws {never} Never directly.
     */
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      action();
    };
    /**
     * Release work promptly when its document or source selection ends.
     * @returns Completion of this operation's cancellation.
     * @throws {never} Never directly.
     */
    const abort = (): void => settle(() => reject(new DOMException('Model inspection cancelled', 'AbortError')));
    worker.onmessage = (event: MessageEvent<ModelImportWorkerAnswer>): void => {
      const answer = event.data;
      settle(() => { if (answer.ok) resolve(answer.selection); else reject(deserializeModelImportError(answer.error)); });
    };
    worker.onerror = (event: ErrorEvent): void => {
      event.preventDefault();
      settle(() => reject(new ModelImportError('invalid', event.message, { detail: '' })));
    };
    worker.onmessageerror = (): void => settle(() => reject(new ModelImportError('invalid', 'Model inspection result could not be read', { detail: '' })));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    const request: ModelImportWorkerRequest = { files, entry, limits };
    try { worker.postMessage(request); } catch (error) {
      settle(() => reject(new ModelImportError('invalid', error instanceof Error ? error.message : String(error), { detail: '' })));
    }
  });
}

/**
 * Prepare a real model preview and retain only resources owned by the import.
 * @param files - Original local source collection.
 * @param entry - User-selected entry or the collection's single entry.
 * @param signal - Owning document operation's cancellation signal.
 * @param limits - Configured input, artifact, decoder and texture budgets.
 * @returns Original artifact, parsed template, metadata and its idempotent release.
 * @throws {DOMException} When the owning import is aborted.
 * @throws {ModelImportError} When inspection, parsing or rendering fails.
 */
export async function prepareSceneModel(files: readonly ModelSource[], entry: string | undefined, signal: AbortSignal, limits: SceneImportLimits): Promise<PreparedModel> {
  const selection = await inspectModelSelectionInWorker(files, entry, signal, limits);
  signal.throwIfAborted();
  const info = { entries: selection.entries, paths: selection.paths, missing: [] };
  const extensions = getUnsupportedModelExtensions(selection.model);
  if (extensions.required.length) throw new ModelImportError('unsupported', 'Unsupported required model extensions', { detail: extensions.required.join(', '), info });
  let renderer: WebGLRenderer | undefined;
  let root: Group | undefined;
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(1, 1);
    root = await parseSceneModel(selection.model, signal, limits, renderer);
    signal.throwIfAborted();
    let meshCount = 0;
    let skinned = false;
    root.traverse((object) => {
      if (object instanceof Mesh) meshCount += 1;
      if (object instanceof SkinnedMesh) skinned = true;
    });
    if (!meshCount) throw new ModelImportError('empty', 'Model contains no displayable mesh', { detail: selection.model.entry, info });
    const box = new Box3().setFromObject(root);
    const center = box.getCenter(new Vector3());
    const diameter = Math.max(box.getSize(new Vector3()).length(), 0.01);
    const camera = new PerspectiveCamera(45, 1, diameter / 1000, diameter * 1000);
    camera.position.copy(center).add(new Vector3(1, 0.7, 1).normalize().multiplyScalar(diameter / (2 * Math.tan(camera.fov * Math.PI / 360))));
    camera.lookAt(center);
    const scene = new Scene();
    const light = new DirectionalLight(0xffffff, 2);
    light.position.set(4, 7, 5);
    scene.add(root, new HemisphereLight(0xffffff, 0x666666, 3), light);
    renderer.render(scene, camera);
    const context = renderer.getContext();
    if (context.isContextLost() || context.getError() !== context.NO_ERROR) throw new ModelImportError('invalid', 'Model preview failed its GPU render', { detail: '', info });
    signal.throwIfAborted();
    root.removeFromParent();
    const preview = root;
    let disposed = false;
    const bytes = selection.artifact;
    const glb = bytes.byteLength >= 4 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === 0x46546c67;
    const base = selection.model.entry.split('/').at(-1)?.replace(/\.(glb|gltf)$/i, '') ?? 'model';
    return {
      file: new File([bytes], `${base}.${glb ? 'glb' : 'zip'}`, { type: glb ? 'model/gltf-binary' : 'application/zip' }),
      preview, entry: selection.model.entry, entries: selection.entries, paths: selection.paths, meshCount, skinned,
      warnings: extensions.optional,
      bounds: { center: center.toArray(), min: box.min.toArray() },
      dispose: (): void => {
        if (disposed) return;
        disposed = true;
        disposeModelTemplate(preview);
      },
    };
  } catch (error) {
    if (root) disposeModelTemplate(root);
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof ModelImportError) throw error.info ? error : error.withInfo(info);
    throw new ModelImportError('invalid', error instanceof Error ? error.message : String(error), { detail: '', info });
  } finally {
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
}
