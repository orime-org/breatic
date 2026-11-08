// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { SceneImportLimits } from '@breatic/shared';
import type { ModelPackage } from '@web/spaces/three-d/model-package';
import { deserializeWorkerError } from '@web/spaces/three-d/model-import-worker-protocol';
import type { ModelImportWorkerAnswer, ModelImportWorkerRequest } from '@web/spaces/three-d/model-import-worker-protocol';
import type { ModelSelection } from '@web/spaces/three-d/model-selection';
import type { ModelSource } from '@web/spaces/three-d/model-source';
import { detectTextureFormatSupport } from '@web/spaces/three-d/model-texture-format';

/**
 * Run one request in its own worker, terminated as soon as it answers or its owner cancels.
 * @param request - The selection to inspect or the registered package to unpack.
 * @param signal - Owning operation's cancellation signal.
 * @param transfer - Buffers handed to the worker without copying.
 * @returns The worker's successful answer.
 * @throws {DOMException} When the owning operation is aborted.
 * @throws {ModelImportError} When the requested check refuses the model.
 * @throws {Error} When the worker cannot start, run or answer, which a retry can resolve.
 */
function runModelImportWorker(request: ModelImportWorkerRequest, signal: AbortSignal, transfer: Transferable[] = []): Promise<Exclude<ModelImportWorkerAnswer, { ok: false }>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Model inspection cancelled', 'AbortError')); return; }
    let worker: Worker;
    try {
      worker = new Worker(new URL('./model-import-worker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      reject(new Error(error instanceof Error ? error.message : String(error)));
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
     * Release work promptly when its document, selection or model lease ends.
     * @returns Nothing.
     * @throws {never} Never directly.
     */
    const abort = (): void => settle(() => reject(new DOMException('Model inspection cancelled', 'AbortError')));
    worker.onmessage = (event: MessageEvent<ModelImportWorkerAnswer>): void => {
      const answer = event.data;
      settle(() => { if (answer.ok) resolve(answer); else reject(deserializeWorkerError(answer.error)); });
    };
    worker.onerror = (event: ErrorEvent): void => {
      event.preventDefault();
      settle(() => reject(new Error(event.message)));
    };
    worker.onmessageerror = (): void => settle(() => reject(new Error('Model inspection result could not be read')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try { worker.postMessage(request, transfer); } catch (error) {
      settle(() => reject(new Error(error instanceof Error ? error.message : String(error))));
    }
  });
}

/**
 * Inspect one original file collection in its own cancellable worker.
 * @param files - Original files under their paths in the user's collection.
 * @param entry - Explicit selected entry when the collection contains several models.
 * @param signal - Owning import operation's cancellation signal.
 * @param limits - Project's import budgets.
 * @returns Checked resources and the deterministic registered artifact.
 * @throws {DOMException} When the owning operation is aborted.
 * @throws {ModelImportError} When inspection refuses the selection.
 * @throws {Error} When the worker cannot start, run or answer.
 */
export async function inspectModelSelectionInWorker(files: readonly ModelSource[], entry: string | undefined, signal: AbortSignal, limits: SceneImportLimits): Promise<ModelSelection> {
  // GLTFLoader probes WebP and AVIF with an Image, which only the main thread has.
  const support = await detectTextureFormatSupport();
  const answer = await runModelImportWorker({ kind: 'selection', files, entry, limits, support }, signal);
  if (!('selection' in answer)) throw new Error('Model inspection answered without a selection');
  return answer.selection;
}

/**
 * Unpack a registered model package in its own worker, which a cancelled model lease terminates.
 * @param bytes - The registered package bytes, handed to the worker.
 * @param signal - The model lease's cancellation signal.
 * @param limits - Project's import budgets.
 * @returns The package's checked entry and resources.
 * @throws {DOMException} When the lease is cancelled.
 * @throws {ModelImportError} When the package is invalid.
 * @throws {Error} When the worker cannot start, run or answer.
 */
export async function readRegisteredModelPackageInWorker(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal, limits: SceneImportLimits): Promise<ModelPackage> {
  const support = await detectTextureFormatSupport();
  const answer = await runModelImportWorker({ kind: 'registered', bytes, limits, support }, signal, [bytes.buffer]);
  if (!('model' in answer)) throw new Error('Model package answered without a model');
  return answer.model;
}
