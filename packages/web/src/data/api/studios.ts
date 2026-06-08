// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio REST client — the container shell (slice 1).
 *
 * Plain async functions (the data layer stays React-free; the `useQuery`
 * bindings live in the pages that consume these). Both endpoints require
 * auth (the httpOnly session cookie rides along via `withCredentials`).
 */

import { apiGet } from '@web/data/api/request';
import type {
  ProjectSummary,
  StudioDetail,
  StudioMemberSummary,
  StudioSummary,
} from '@breatic/shared';

export const studiosApi = {
  /**
   * `GET /api/v1/studios` — the current user's studios (switcher list),
   * personal-first.
   * @returns the user's studios as summaries.
   */
  listUserStudios(): Promise<StudioSummary[]> {
    return apiGet<StudioSummary[]>('/studios');
  },
  /**
   * `GET /api/v1/studio/:slug` — one studio's public-facing shell, with the
   * viewer's role (`admin` / `member` / `null` = guest). Rejects with a 404
   * `ApiException` when no active studio has that slug.
   * @param slug the studio's URL handle.
   * @returns the studio detail.
   */
  get(slug: string): Promise<StudioDetail> {
    return apiGet<StudioDetail>(`/studio/${slug}`);
  },
  /**
   * `GET /api/v1/studio/:slug/projects` — the studio's projects the viewer may
   * see (slice 2 open-baseline visibility, server-side filtered): a member
   * sees studio-visible projects + their own-role private ones, an admin sees
   * all, a guest gets an empty list. Each row carries the viewer's `myRole`
   * (`null` for a studio-visible project not yet entered).
   * @param slug the studio's URL handle.
   * @returns the visible project summaries.
   */
  listProjects(slug: string): Promise<ProjectSummary[]> {
    return apiGet<ProjectSummary[]>(`/studio/${slug}/projects`);
  },
  /**
   * `GET /api/v1/studio/:slug/members` — the studio's active members for the
   * Members tab (display name / email / role / join date). A personal studio
   * returns exactly its owner; a team studio returns all members.
   * @param slug the studio's URL handle.
   * @returns the member summaries.
   */
  listMembers(slug: string): Promise<StudioMemberSummary[]> {
    return apiGet<StudioMemberSummary[]>(`/studio/${slug}/members`);
  },
};
