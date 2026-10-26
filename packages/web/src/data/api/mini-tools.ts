// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MiniToolExecutionRecord, MiniToolPlannedRequest, MiniToolRequest } from '@breatic/shared/mini-tools';

import { apiPost, runOnceRequest } from '@web/data/api/request';
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
   * @param _body - The frozen public plan.
   * @param _key - The original press identity.
   * @returns The admitted task's state.
   * @throws {Error} Until planned API wiring is implemented.
   */
  runPlanned(_body: MiniToolPlannedRequest, _key: string): Promise<MiniToolPlannedRunAnswer> {
    return Promise.reject(new Error('Planned video API submission is not implemented'));
  },
  /**
   * Reads the project-authorized original run and canonical results.
   * @param _projectId - The containing Project.
   * @param _runId - The original accepted run identity.
   * @returns The validated public execution record.
   * @throws {Error} Until planned API reading is implemented.
   */
  getRun(_projectId: string, _runId: string): Promise<MiniToolExecutionRecord> {
    return Promise.reject(new Error('Planned video API reading is not implemented'));
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
