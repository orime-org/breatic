// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { TaskCreateInput } from '@breatic/shared';

import { canvasApi } from '@web/data/api/canvas';
import { useUploadMarksStore } from '@web/stores/upload-marks';

/**
 * Submit a generation for its node, as an operation started on that node
 * (inner#1303 §6.7): the node waits while the request is out, which replaces
 * any failure line an earlier upload or tool left on it, and the wait ends
 * once the server answers either way. A refusal goes on to the caller, whose
 * toast says why.
 * @param spaceId - The canvas space.
 * @param nodeId - The node the result goes to.
 * @param payload - The task.
 * @throws {Error} The server's refusal, or a failure to reach it.
 */
export async function createNodeTask(spaceId: string, nodeId: string, payload: TaskCreateInput): Promise<void> {
  const op = useUploadMarksStore.getState().begin(spaceId, nodeId, 'generate');
  try {
    await canvasApi.createTask(payload);
  } finally {
    useUploadMarksStore.getState().answer(spaceId, nodeId, op);
  }
}
