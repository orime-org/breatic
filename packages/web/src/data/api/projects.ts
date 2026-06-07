// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { ProjectRole } from '@web/stores';
import type { ProjectVisibility } from '@breatic/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from '@web/data/api/request';
import type { Pagination } from '@web/data/api/types';

/**
 * Project list row — mirrors backend `ProjectEntity` returned by
 * `GET /api/v1/projects` (server sends an array, no `{projects, meta}`
 * wrapper inside the envelope). `role` is not populated on the list
 * endpoint — personal-studio v1 means every project is owner; per-row
 * role lands when sharing UI ships.
 */
export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  thumbnailUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  studioId: string;
  createdByUserId: string;
  /** Caller's role on this project (membership-aware reads only). */
  myRole?: ProjectRole;
  /** Soft-delete marker; null for live projects. */
  deletedAt: string | null;
}

export const projectsApi = {
  list(params: Pagination = {}) {
    return apiGet<ProjectSummary[]>('/projects', { params });
  },
  get(id: string) {
    return apiGet<ProjectDetail>(`/projects/${id}`);
  },
  create(body: {
    name: string;
    slug: string;
    visibility: ProjectVisibility;
    description?: string;
  }) {
    return apiPost<ProjectDetail>('/projects', body);
  },
  duplicate(id: string) {
    return apiPost<ProjectDetail>(`/projects/${id}/duplicate`, {});
  },
  rename(id: string, name: string) {
    return apiPatch<ProjectDetail>(`/projects/${id}`, { name });
  },
  delete(id: string) {
    return apiDelete(`/projects/${id}`);
  },
};
