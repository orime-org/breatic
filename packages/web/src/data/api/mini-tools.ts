// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MiniToolRequest } from '@breatic/shared';

import { apiPost } from '@web/data/api/request';

/** What the server answers a run with: the task it opened. */
export interface MiniToolRunAnswer {
  task_id: string;
  status: 'pending' | 'failed';
}

export const miniToolsApi = {
  /**
   * Run a model or container mini-tool into nodes that already exist
   * (inner#888 §6.1).
   * @param body - The run, as the shared request schema reads it.
   * @returns The task the server opened.
   * @throws {import('@web/data/api/types').ApiException} When no task was opened.
   */
  run(body: MiniToolRequest): Promise<MiniToolRunAnswer> {
    return apiPost<MiniToolRunAnswer>('/mini-tools', body);
  },
};
