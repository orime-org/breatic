// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { inspectModelSelection } from '@web/spaces/three-d/model-selection';
import { serializeModelImportError } from '@web/spaces/three-d/model-import-worker-protocol';
import type { ModelImportWorkerAnswer, ModelImportWorkerRequest } from '@web/spaces/three-d/model-import-worker-protocol';

self.onmessage = (event: MessageEvent<ModelImportWorkerRequest>): void => {
  const { files, entry, limits } = event.data;
  void inspectModelSelection(files, entry, limits).then((selection) => {
    const answer: ModelImportWorkerAnswer = { ok: true, selection };
    const buffers = new Set([...selection.model.files.values()].map((bytes) => bytes.buffer));
    buffers.add(selection.artifact.buffer);
    self.postMessage(answer, { transfer: [...buffers] });
  }).catch((error: unknown) => {
    const answer: ModelImportWorkerAnswer = { ok: false, error: serializeModelImportError(error) };
    self.postMessage(answer);
  });
};
