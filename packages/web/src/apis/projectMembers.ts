/**
 * Project members API client (v10 §7.2.6).
 *
 * Pairs with `/api/v1/projects/:pid/members` server routes.
 * Frontend hooks (`useProjectMembers` in PR-D) wrap these calls
 * with stateless-message-driven cache invalidation.
 */

import { request } from '@/utils/request';
import type { ApiResponse, ProjectMember, ProjectRole } from '@breatic/shared';

/** List active members of a project (any current member can read). */
export const list = (projectId: string) =>
  request<ApiResponse<ProjectMember[]>>({
    url: `/api/v1/projects/${projectId}/members`,
    method: 'get',
  });

/**
 * Invite a user. Owner only. `role` must be `'view'` or `'edit'` —
 * owner promotion is the transfer-owner endpoint, deferred to V2.
 */
export const invite = (
  projectId: string,
  body: { user_id: string; role: Exclude<ProjectRole, 'owner'> },
) =>
  request<ApiResponse<{ ok: true }>>({
    url: `/api/v1/projects/${projectId}/members`,
    method: 'post',
    data: body,
  });

/** Change a member's role between view and edit. Owner only. */
export const changeRole = (
  projectId: string,
  userId: string,
  role: Exclude<ProjectRole, 'owner'>,
) =>
  request<ApiResponse<{ ok: true }>>({
    url: `/api/v1/projects/${projectId}/members/${userId}`,
    method: 'patch',
    data: { role },
  });

/** Soft-remove a member. Owner only. Owner cannot be removed. */
export const remove = (projectId: string, userId: string) =>
  request<ApiResponse<{ ok: true }>>({
    url: `/api/v1/projects/${projectId}/members/${userId}`,
    method: 'delete',
  });
