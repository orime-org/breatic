// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ProjectAssetPage, ProjectRegisteredAsset, TimelineClientLimits } from '@breatic/shared';
import { apiGet } from '@web/data/api/request';

export const timelineApi = {
  /**
   * Read one page of registered videos accepted by this Project.
   * @param projectId - The Project being edited.
   * @param cursor - The previous page's opaque cursor.
   * @param signal - Cancellation for this read.
   * @returns Canonical registered video metadata and the next page cursor.
   * @throws {ApiException} When the authenticated request fails.
   */
  listVideos(projectId: string, cursor?: string, signal?: AbortSignal): Promise<ProjectAssetPage> {
    return apiGet(`/projects/${projectId}/assets`, { params: { kind: 'video', cursor }, signal });
  },
  /**
   * Resolve a clip's fixed registered asset through current Project access.
   * @param projectId - The Project whose relationship is required.
   * @param assetId - The source's stable asset identity.
   * @param signal - Cancellation for this read.
   * @returns The current canonical media projection.
   * @throws {ApiException} When the asset is unavailable or the request fails.
   */
  resolveAsset(projectId: string, assetId: string, signal?: AbortSignal): Promise<ProjectRegisteredAsset> {
    return apiGet(`/projects/${projectId}/assets/${assetId}`, { signal });
  },
  /**
   * Read authorized creation defaults and asset paging settings.
   * @param projectId - The Project being opened.
   * @param signal - Cancellation for this read.
   * @returns Only public Timeline configuration.
   * @throws {ApiException} When the authenticated request fails.
   */
  limits(projectId: string, signal?: AbortSignal): Promise<TimelineClientLimits> {
    return apiGet(`/projects/${projectId}/timeline-limits`, { signal });
  },
};
