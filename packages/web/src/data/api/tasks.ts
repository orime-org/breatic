// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { apiGet } from '@web/data/api/request';
import type { CanvasTask } from '@web/data/api/canvas';

export const tasksApi = {
  list(params: { page?: number; limit?: number } = {}) {
    return apiGet<{ tasks: CanvasTask[] }>('/tasks', { params });
  },
  get(id: string) {
    return apiGet<CanvasTask>(`/tasks/${id}`);
  },
};
