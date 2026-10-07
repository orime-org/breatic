// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { QueryClient } from '@tanstack/react-query';
import type { ProjectRole, SpaceType, StudioProjectSort } from '@breatic/shared';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '@web/data/api/request';

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
  /** When the project was archived (read-only for everyone), or null while live. */
  archivedAt: string | null;
  /** Whether the caller may rename it: the studio admin or its owner, on a live project. */
  canManageMeta: boolean;
  /** Whether the caller may restore it: a studio admin, on an archived project. */
  canRestore: boolean;
  /** Whether the caller may leave it: an editor or a viewer, on a live project. */
  canLeave: boolean;
}

/**
 * An outstanding ownership offer on a container.
 *
 * "Live" means pending AND not past its deadline. The two are different
 * questions: the uniqueness index deliberately ignores the deadline, so an
 * offer that died on day eight is still `pending` — showing it would put a
 * withdraw button on something already over.
 */
export interface LiveTransfer {
  id: string;
  fromUserId: string;
  toUserId: string;
  /** ISO instant; the offer stops being answerable after it. */
  expiresAt: string;
}

/** Which studio projects list a cached query holds. */
export interface StudioProjectsListKeyParts {
  archived: boolean;
  sort: StudioProjectSort;
  /** Names sort by the interface language, so each language is its own list. */
  locale: string;
}

/**
 * The React Query key of one studio projects list.
 * @param slug the studio's URL handle.
 * @param parts which list, in which sort and language.
 * @returns the key.
 */
export function studioProjectsListKey(
  slug: string,
  parts: StudioProjectsListKeyParts,
): readonly ['studio', string, 'projects', StudioProjectsListKeyParts] {
  return ['studio', slug, 'projects', parts];
}

/**
 * Whether a React Query key is a studio container projects-list key (built by
 * {@link studioProjectsListKey}), so every studio's lists can be refreshed from
 * a caller that knows only the project id.
 * @param key the React Query key to test.
 * @returns whether the key is a studio projects-list key.
 */
export function isStudioProjectsListKey(key: readonly unknown[]): boolean {
  return key[0] === 'studio' && key[2] === 'projects';
}

/**
 * Refetch everything that shows a project's name or which list it is in:
 * every studio's projects lists, the recent page and the project itself.
 * @param queryClient - The app's query client.
 * @param projectId - The project that changed.
 */
export function invalidateProjectListings(queryClient: QueryClient, projectId: string): void {
  void queryClient.invalidateQueries({
    predicate: (query) => isStudioProjectsListKey(query.queryKey),
  });
  void queryClient.invalidateQueries({ queryKey: ['studios', 'recent'] });
  void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
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
    /**
     * The first space's type, seeded on first open (B.2). Defaults to canvas
     * server-side.
     */
    spaceType: SpaceType;
    description?: string;
  }) {
    return apiPost<ProjectDetail>('/projects', body);
  },
  duplicate(id: string) {
    return apiPost<ProjectDetail>(`/projects/${id}/duplicate`, {});
  },
  /**
   * `POST /api/v1/projects/:id/archive` — archive the project. Studio admin only.
   * @param id the bare project uuid.
   * @returns once the project is archived.
   */
  archive(id: string) {
    return apiPost<{ ok: true }>(`/projects/${id}/archive`, {});
  },
  /**
   * `DELETE /api/v1/projects/:id/membership` — leave the project. Any member
   * but the owner, on a live project.
   * @param id the bare project uuid.
   * @returns once the caller is no longer a member.
   */
  leave(id: string) {
    return apiDelete<{ ok: true }>(`/projects/${id}/membership`);
  },
  /**
   * `POST /api/v1/projects/:id/restore` — bring an archived project back.
   * Studio admin only; refused when the studio has no room for one more.
   * @param id the bare project uuid.
   * @returns once the project is live again.
   */
  restore(id: string) {
    return apiPost<{ ok: true }>(`/projects/${id}/restore`, {});
  },
  rename(id: string, name: string) {
    return apiPatch<ProjectDetail>(`/projects/${id}`, { name });
  },
  /**
   * `PUT /api/v1/projects/:id/cover` — point the project's cover at an
   * uploaded picture. Same gate as a rename: the studio's admin or the
   * project's owner.
   * @param id the bare project uuid.
   * @param assetId the uploaded picture's ledger row.
   * @returns the updated project.
   */
  setCover(id: string, assetId: string) {
    return apiPut<ProjectDetail>(`/projects/${id}/cover`, { asset_id: assetId });
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

  /**
   * `GET /api/v1/projects/:id/transfer` — the project's outstanding ownership
   * offer, or null. Owner-only; it is the owner's own "pending · withdraw"
   * surface.
   * @param id the bare project uuid.
   * @returns the live offer, or null when there is none.
   */
  liveTransfer(id: string): Promise<LiveTransfer | null> {
    return apiGet<LiveTransfer | null>(`/projects/${id}/transfer`);
  },

  /**
   * `DELETE /api/v1/projects/:id/transfer/:transferId` — the CURRENT owner
   * withdraws an outstanding offer, freeing the project's slot at once.
   *
   * Withdrawal belongs to whoever owns the project now, not to whoever sent the
   * offer: after a transfer the former owner is gone, and a second unanswered
   * offer would block ownership for a week with the only key held by someone
   * who has left.
   * @param id the bare project uuid.
   * @param transferId the offer being withdrawn.
   * @returns once the offer is withdrawn.
   */
  withdrawTransfer(id: string, transferId: string): Promise<{ ok: true }> {
    return apiDelete<{ ok: true }>(`/projects/${id}/transfer/${transferId}`);
  },
};
