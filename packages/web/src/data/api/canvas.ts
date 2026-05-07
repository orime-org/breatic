/**
 * Canvas API — AIGC task creation and understand.
 */

import { request } from '@/data/api/request';
import type { TaskEntity, ApiResponse, PaginatedResponse, TaskCreateInput, UnderstandInput } from '@breatic/shared';

/** Create an AIGC generation task. */
export const createTask = (data: TaskCreateInput) =>
  request<ApiResponse<TaskEntity>>({
    url: '/api/v1/canvas/tasks',
    method: 'post',
    data,
  });

/** Analyze media content (image/video/audio understanding). */
export const understand = (data: UnderstandInput) =>
  request<ApiResponse<TaskEntity>>({
    url: '/api/v1/canvas/understand',
    method: 'post',
    data,
  });

/** List tasks for the current user. */
export const listTasks = (params: { limit?: number; offset?: number } = {}) =>
  request<PaginatedResponse<TaskEntity>>({
    url: '/api/v1/canvas/tasks',
    method: 'get',
    params,
  });

/** Get a single task by ID. */
export const getTask = (id: string) =>
  request<ApiResponse<TaskEntity>>({
    url: `/api/v1/tasks/${id}`,
    method: 'get',
  });
