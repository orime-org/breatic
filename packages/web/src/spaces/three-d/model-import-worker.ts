// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readRegisteredModelPackage } from '@web/spaces/three-d/model-package';
import type { ModelPackage } from '@web/spaces/three-d/model-package';
import { inspectModelSelection } from '@web/spaces/three-d/model-selection';
import { serializeWorkerError } from '@web/spaces/three-d/model-import-worker-protocol';
import type { ModelImportWorkerAnswer, ModelImportWorkerRequest } from '@web/spaces/three-d/model-import-worker-protocol';

/**
 * Collect the byte buffers a model answer can hand over without copying.
 * @param model - The checked model resources.
 * @returns Each distinct backing buffer once.
 * @throws {never} Never.
 */
function modelBuffers(model: ModelPackage): Set<ArrayBuffer> {
  return new Set([...model.files.values()].map((bytes) => bytes.buffer));
}

self.onmessage = (event: MessageEvent<ModelImportWorkerRequest>): void => {
  const request = event.data;
  void (async (): Promise<void> => {
    if (request.kind === 'registered') {
      const model = readRegisteredModelPackage(request.bytes, request.limits, request.support);
      const answer: ModelImportWorkerAnswer = { ok: true, model };
      self.postMessage(answer, { transfer: [...modelBuffers(model)] });
      return;
    }
    const selection = await inspectModelSelection(request.files, request.entry, request.limits, request.support);
    const answer: ModelImportWorkerAnswer = { ok: true, selection };
    self.postMessage(answer, { transfer: [...modelBuffers(selection.model).add(selection.artifact.buffer)] });
  })().catch((error: unknown) => {
    const answer: ModelImportWorkerAnswer = { ok: false, error: serializeWorkerError(error) };
    self.postMessage(answer);
  });
};
