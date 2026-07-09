// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { TaskCreateInput } from '@breatic/shared';

import { apiGet, apiPost } from '@web/data/api/request';

export interface CanvasTask {
  id: string;
  projectId: string;
  spaceId: string;
  nodeId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  createdAt: string;
  finishedAt?: string;
  resultUrl?: string;
  errorMessage?: string;
}

export const canvasApi = {
  /**
   * Enqueue a canvas generation task. The body is the shared
   * {@link TaskCreateInput} wire contract (snake_case); build it with
   * `buildGenerateTaskPayload` for image-node Generate.
   * @param body - The `POST /canvas/tasks` request body.
   * @returns The created task (unwrapped from the `{ data }` envelope).
   * @throws {import('@web/data/api/types').ApiException} On 402 / 409 / 503 etc.
   */
  createTask(body: TaskCreateInput): Promise<CanvasTask> {
    return apiPost<CanvasTask>('/canvas/tasks', body);
  },
  understand(body: {
    projectId: string;
    spaceId: string;
    nodeId: string;
    sourceUrl: string;
    /** asr | description | etc. */
    kind: string;
  }) {
    return apiPost<CanvasTask>('/canvas/understand', body);
  },
  listTasks(projectId: string, params: { page?: number; limit?: number } = {}) {
    return apiGet<{ tasks: CanvasTask[] }>('/canvas/tasks', {
      params: { projectId, ...params },
    });
  },
};
