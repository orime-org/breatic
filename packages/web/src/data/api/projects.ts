// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { ProjectRole } from '@web/stores';
import type { ProjectVisibility, SpaceType } from '@breatic/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from '@web/data/api/request';

/**
 * Shared base shape for a single project (the fields `ProjectDetail` extends).
 * The studio container lists projects via the studio-scoped
 * `GET /studio/:slug/projects` endpoint (shared `ProjectSummary`), not this
 * type — this one only backs the single-project reads below.
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
  get(id: string) {
    return apiGet<ProjectDetail>(`/projects/${id}`);
  },
  create(body: {
    /** The studio to create the project in (the create gate checks the caller's role on it). */
    studioId: string;
    name: string;
    slug: string;
    visibility: ProjectVisibility;
    /** The first space's type, seeded on first open (B.2). Defaults to canvas server-side. */
    spaceType: SpaceType;
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
  /**
   * `POST /api/v1/projects/:id/opened` — record that the caller just opened
   * this project, floating it to the top of their cross-studio "Recent" feed.
   * Access-gated server-side (404 when the caller cannot view it) and
   * idempotent (re-opening just bumps the timestamp). Fire-and-forget from the
   * project page on mount.
   * @param id the bare project uuid.
   * @returns once the open has been recorded.
   */
  recordOpen(id: string) {
    return apiPost<{ ok: boolean }>(`/projects/${id}/opened`, {});
  },
  delete(id: string) {
    return apiDelete(`/projects/${id}`);
  },
  /**
   * `POST /api/v1/projects/:id/transfer-owner` — the current owner asks a
   * project collaborator (who is also a non-guest studio member) to take over
   * as owner. Owner-only; sends an actionable notification (+ best-effort email)
   * to the recipient — no role change until they confirm. Rejects with a typed
   * `ApiException`: `403` not the owner / personal studio, `422` recipient
   * ineligible (not a project member, not a studio member, or a guest).
   * @param id the bare project uuid.
   * @param toUserId the proposed new owner's user id (from the candidate picker).
   * @returns once the transfer request has been sent.
   */
  transferOwner(id: string, toUserId: string) {
    return apiPost<{ ok: boolean }, { toUserId: string }>(
      `/projects/${id}/transfer-owner`,
      { toUserId },
    );
  },
};
