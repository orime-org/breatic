// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { apiDelete, apiGet, apiPost } from '@web/data/api/request';

/** What the join dialog shows about a project the caller cannot enter. */
export interface MyJoinRequest {
  /** `archivedAt` is set when the project is archived, which takes no requests. */
  project: { id: string; name: string; studioSlug: string; archivedAt: string | null };
  /** The caller's own live request here, or null when they have none. */
  pendingRequest: { id: string; createdAt: string } | null;
}

export const projectJoinRequestsApi = {
  /**
   * The project's name, its studio, and the caller's own pending request.
   * @param projectId - The project the caller cannot enter.
   * @returns What the join dialog renders.
   */
  mine(projectId: string): Promise<MyJoinRequest> {
    return apiGet<MyJoinRequest>(`/projects/${projectId}/join-requests/mine`);
  },

  /**
   * Ask the project's owner to let the caller in.
   * @param projectId - The project.
   * @param message - Optional note for the owner.
   * @returns Once the request is filed.
   */
  async request(projectId: string, message?: string): Promise<void> {
    await apiPost<null>(`/projects/${projectId}/join-requests`, message ? { message } : {});
  },

  /**
   * Withdraw the caller's pending request on a project.
   * @param projectId - The project.
   * @returns Once it is withdrawn.
   */
  async cancelMine(projectId: string): Promise<void> {
    await apiDelete<null>(`/projects/${projectId}/join-requests/mine`);
  },
};
