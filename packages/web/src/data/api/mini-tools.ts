// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { miniToolExecutionRecordSchema, type MiniToolExecutionRecord, type MiniToolExecutionRetryRequest, type MiniToolPlannedRequest, type MiniToolRequest } from '@breatic/shared/mini-tools';

import { apiGet, apiPost, runOnceRequest } from '@web/data/api/request';
import { noteCreditsChanged } from '@web/data/api/credits';

/** What the server answers a run with: the task it opened. */
export interface MiniToolRunAnswer {
  task_id: string;
  status: 'pending' | 'failed';
}

/** The planned admission's existing task identity and all persisted statuses. */
export interface MiniToolPlannedRunAnswer {
  task_id: string;
  status: MiniToolExecutionRecord['status'];
}

export const miniToolsApi = {
  /**
   * Sends one complete planned request with its stable press key.
   * @param body - The frozen public plan.
   * @param key - The original press identity.
   * @returns The admitted task's state.
   * @throws {import('@web/data/api/types').ApiException} When admission is refused or unreachable.
   */
  runPlanned(body: MiniToolPlannedRequest, key: string): Promise<MiniToolPlannedRunAnswer> {
    return apiPost<MiniToolPlannedRunAnswer>('/mini-tools', body, runOnceRequest(key)).finally(() =>
      noteCreditsChanged(body.project_id),
    );
  },
  /**
   * Retries a run's failed outputs on its frozen plan (frames-split §7.11 retry row), with its stable press key.
   * @param body - The retry.
   * @param key - The original press identity.
   * @returns The admitted task's state.
   * @throws {import('@web/data/api/types').ApiException} When admission is refused or unreachable.
   */
  retryPlannedVideoRun(body: MiniToolExecutionRetryRequest, key: string): Promise<MiniToolPlannedRunAnswer> {
    return apiPost<MiniToolPlannedRunAnswer>('/mini-tools', body, runOnceRequest(key)).finally(() =>
      noteCreditsChanged(body.project_id),
    );
  },
  /**
   * Quotes a planned request by the admission's own computation, writing nothing (§97 D26-1).
   * @param body - The planned request the Run would send.
   * @returns The credits admission would freeze.
   * @throws {import('@web/data/api/types').ApiException} When admission would refuse the body, or the server is unreachable.
   */
  quotePlannedVideoRun(body: MiniToolPlannedRequest): Promise<{ credits: number }> {
    return apiPost<{ credits: number }>('/mini-tools/quote', body);
  },
  /**
   * Reads the project-authorized original run and canonical results.
   * @param projectId - The containing Project.
   * @param runId - The original accepted run identity.
   * @returns The validated public execution record.
   * @throws {Error} When the request fails or its execution record is invalid.
   */
  async getRun(projectId: string, runId: string): Promise<MiniToolExecutionRecord> {
    return miniToolExecutionRecordSchema.parse(await apiGet<unknown>(`/projects/${projectId}/mini-tool-runs/${runId}`));
  },
  /**
   * Run a model or container mini-tool into nodes that already exist
   * (inner#888 §6.1).
   * @param body - The run, as the shared request schema reads it.
   * @param key - The press's `Idempotency-Key`; a re-send with it runs nothing new.
   * @returns The task the server opened.
   * @throws {import('@web/data/api/types').ApiException} When no task was opened.
   */
  run(body: MiniToolRequest, key: string): Promise<MiniToolRunAnswer> {
    // Admitted or refused, the run held or failed to hold the project's
    // credits, so the top bar reads them again (inner#1611).
    return apiPost<MiniToolRunAnswer>('/mini-tools', body, runOnceRequest(key)).finally(() =>
      noteCreditsChanged(body.project_id),
    );
  },
};
