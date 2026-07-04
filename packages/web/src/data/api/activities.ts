// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { ProjectActivityPage } from '@breatic/shared';
import { apiGet } from '@web/data/api/request';

export const activitiesApi = {
  /**
   * One keyset page of a project's activity feed, newest first
   * (ADR 2026-07-04 project-activity-feed). Pass the previous page's
   * `nextCursor` to fetch older entries; omit it for the first page.
   * @param projectId - Project whose feed to read.
   * @param cursor - Opaque cursor from the previous page, if paging.
   * @returns The page items + the next opaque cursor (null at the end).
   */
  list(projectId: string, cursor?: string): Promise<ProjectActivityPage> {
    return apiGet<ProjectActivityPage>(`/projects/${projectId}/activities`, {
      params: cursor ? { cursor } : {},
    });
  },
};
