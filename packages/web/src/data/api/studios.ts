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
import type { StudioDetail, StudioSummary } from '@breatic/shared';

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
};
