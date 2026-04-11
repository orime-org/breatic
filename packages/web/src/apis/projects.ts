/**
 * Projects API — CRUD for creative projects.
 */

import { request, type CustomAxiosRequestConfig } from '@/utils/request';
import type { ProjectEntity, ApiResponse, ProjectCreateInput } from '@breatic/shared';

/**
 * List projects for the current user, most-recently-updated first.
 *
 * The backend currently returns a simple `{ data: ProjectEntity[] }`
 * envelope without pagination metadata; callers use the length of
 * the returned page to infer whether another page is available.
 */
export const list = (params: { limit?: number; offset?: number } = {}, needGlobalLoading = false) =>
  request<ApiResponse<ProjectEntity[]>>({
    url: '/api/v1/projects',
    method: 'get',
    params,
    needGlobalLoading,
  } as CustomAxiosRequestConfig);

/** Create a new project. */
export const create = (data: ProjectCreateInput, needGlobalLoading = false) =>
  request<ApiResponse<ProjectEntity>>({
    url: '/api/v1/projects',
    method: 'post',
    data,
    needGlobalLoading,
  } as CustomAxiosRequestConfig);

/**
 * Update project metadata (name, description, thumbnail).
 *
 * Only include fields that should change. `null` clears a nullable
 * field; `undefined` leaves it alone.
 */
export const update = (
  id: string,
  data: { name?: string; description?: string | null; thumbnail_url?: string | null },
) =>
  request<ApiResponse<ProjectEntity>>({
    url: `/api/v1/projects/${id}`,
    method: 'put',
    data,
  });

/**
 * Duplicate a project. The backend copies the project row and every
 * Yjs document (canvas + per-node editors) in a single transaction.
 * The new project is owned by the authenticated user.
 */
export const duplicate = (id: string) =>
  request<ApiResponse<ProjectEntity>>({
    url: `/api/v1/projects/${id}/duplicate`,
    method: 'post',
  });

/** Save a legacy canvas data JSON snapshot. */
export const saveCanvas = (id: string, data: { canvas_data: Record<string, unknown> }) =>
  request<ApiResponse<{ success: true }>>({
    url: `/api/v1/projects/${id}/canvas`,
    method: 'put',
    data,
  });

/** Soft-delete a project. */
export const remove = (id: string) =>
  request<ApiResponse<{ success: true }>>({
    url: `/api/v1/projects/${id}`,
    method: 'delete',
  });
