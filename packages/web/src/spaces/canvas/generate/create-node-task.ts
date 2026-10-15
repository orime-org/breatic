// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { TaskCreateInput } from '@breatic/shared';

import { canvasApi } from '@web/data/api/canvas';
import { useUploadMarksStore } from '@web/stores/upload-marks';

/**
 * Submit a generation for its node (inner#1303 §6.7). Once the server takes
 * it, a failure line an earlier upload or tool left on the node goes; the
 * generation's own progress shows in the node's task count. A refusal goes on
 * to the caller, whose toast says why.
 * @param spaceId - The canvas space.
 * @param nodeId - The node the result goes to.
 * @param payload - The task.
 * @param idempotencyKey - The press's key, the same on every re-send (inner#1490).
 * @throws {Error} The server's refusal, or a failure to reach it.
 */
export async function createNodeTask(
  spaceId: string,
  nodeId: string,
  payload: TaskCreateInput,
  idempotencyKey: string,
): Promise<void> {
  await canvasApi.createTask(payload, idempotencyKey);
  useUploadMarksStore.getState().clearFailed(spaceId, nodeId);
}
