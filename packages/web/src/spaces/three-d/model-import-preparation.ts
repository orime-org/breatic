// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Box3, DirectionalLight, HemisphereLight, Mesh, PerspectiveCamera, Scene, SkinnedMesh, Vector3, WebGLRenderer } from 'three';
import type { Group } from 'three';
import type { SceneImportLimits } from '@breatic/shared';
import type { PreparedModel } from '@web/spaces/three-d/model-import-controller';
import { contentFailure, ModelImportError } from '@web/spaces/three-d/model-import-errors';
import { inspectModelSelectionInWorker } from '@web/spaces/three-d/model-import-worker-client';
import type { ModelSource } from '@web/spaces/three-d/model-source';
import { getUnsupportedModelExtensions } from '@web/spaces/three-d/viewport/model-decoder-173';
import { disposeModelTemplate, parseSceneModel } from '@web/spaces/three-d/viewport/model-resources';

/**
 * Prepare a real model preview and retain only resources owned by the import.
 * @param files - Original local source collection.
 * @param entry - User-selected entry or the collection's single entry.
 * @param signal - Owning document operation's cancellation signal.
 * @param limits - Configured input, artifact, decoder and texture budgets.
 * @returns Original artifact, parsed template, metadata and its idempotent release.
 * @throws {DOMException} When the owning import is aborted.
 * @throws {ModelImportError} When inspection or parsing refuses the model.
 * @throws {Error} When a worker, decoder download, renderer or GPU context fails, which a retry can resolve.
 */
export async function prepareSceneModel(files: readonly ModelSource[], entry: string | undefined, signal: AbortSignal, limits: SceneImportLimits): Promise<PreparedModel> {
  const selection = await inspectModelSelectionInWorker(files, entry, signal, limits);
  signal.throwIfAborted();
  const info = { entries: selection.entries, paths: selection.paths, missing: [] };
  const extensions = getUnsupportedModelExtensions(selection.model);
  let renderer: WebGLRenderer | undefined;
  let root: Group | undefined;
  let contextLost = false;
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
    if (box.isEmpty() || ![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite)) {
      throw new ModelImportError('empty', 'Model has no finite displayable geometry', { detail: selection.model.entry, info });
    }
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
    contextLost = context.isContextLost();
    if (contextLost) throw new Error('Model preview lost its GPU context');
    if (context.getError() !== context.NO_ERROR) throw new ModelImportError('invalid', 'Model preview failed its GPU render', { detail: '', info });
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
    // Once the template is parsed, measuring and rendering it judge its content; a lost GPU context says nothing about the model.
    const failure = root && !contextLost ? contentFailure(error) : error;
    if (failure instanceof ModelImportError) throw failure.info ? failure : failure.withInfo(info);
    // A decoder download, renderer or worker failure says nothing about the model, so it stays a retryable plain error.
    throw failure;
  } finally {
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
}
