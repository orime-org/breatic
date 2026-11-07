// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { ProjectAssetPage, ProjectRegisteredAsset, TimelineClientLimits, TimelineExecution } from '@breatic/shared';
import type { TimelineExecutionCreateInput } from '@breatic/shared/space-content';
import { apiGet, apiPost, runOnceRequest } from '@web/data/api/request';
import type { TimelineWebResolution } from '@web/data/yjs/timeline-arrangement';

/** One execution-list row: the execution and the credits its usage adds up to so far. */
export type TimelineExecutionRow = TimelineExecution & { usageCredits: number };

/** What the creation dialog submits: its frozen input, keyed by the Project, Space and action. */
export type TimelineExecutionAcceptBody = TimelineExecutionCreateInput & { projectId: string };

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
  /**
   * List one Space's executions in this Project, newest first.
   * @param projectId - The Project.
   * @param spaceId - The Timeline Space.
   * @param signal - Cancellation for this read.
   * @returns The rows with their usage.
   * @throws {ApiException} When the request fails.
   */
  listExecutions(projectId: string, spaceId: string, signal?: AbortSignal): Promise<TimelineExecutionRow[]> {
    return apiGet('/timeline/executions', { params: { projectId, spaceId }, signal });
  },
  /**
   * Accept a creation once; a resend with the same key answers the same row.
   * @param body - The frozen input.
   * @param key - The press's `Idempotency-Key`.
   * @returns The accepted execution.
   * @throws {ApiException} When it is refused or the request fails.
   */
  acceptExecution(body: TimelineExecutionAcceptBody, key: string): Promise<TimelineExecution> {
    return apiPost('/timeline/executions', body, runOnceRequest(key));
  },
  /**
   * Ask an execution to stop.
   * @param executionId - The execution.
   * @param key - The press's `Idempotency-Key`.
   * @returns The execution after the request.
   * @throws {ApiException} When it is refused or the request fails.
   */
  cancelExecution(executionId: string, key: string): Promise<TimelineExecution> {
    return apiPost(`/timeline/executions/${executionId}/cancel`, undefined, runOnceRequest(key));
  },
  /**
   * Resolve the source versions and executions a document's web copies reference.
   * @param projectId - The Project the document belongs to.
   * @param ids - The referenced ids.
   * @param ids.sourceIds - Source versions.
   * @param ids.executionIds - Executions placeholders wait for.
   * @param signal - Cancellation for this read.
   * @returns What this Project may read; anything else is left out.
   * @throws {ApiException} When the request fails.
   */
  resolveWebSources(projectId: string, ids: { sourceIds: readonly string[]; executionIds: readonly string[] }, signal?: AbortSignal): Promise<TimelineWebResolution> {
    return apiGet('/timeline/web-sources', { params: { projectId, sourceIds: ids.sourceIds.join(','), executionIds: ids.executionIds.join(',') }, signal });
  },
  /**
   * Sign a preview address for one source version, read through this Project.
   * @param projectId - The Project.
   * @param sourceVersionId - The source version.
   * @param signal - Cancellation for this read.
   * @returns The address of its page.
   * @throws {ApiException} When it is not readable or the request fails.
   */
  previewUrl(projectId: string, sourceVersionId: string, signal?: AbortSignal): Promise<{ url: string }> {
    return apiGet(`/timeline/sources/${sourceVersionId}/preview`, { params: { projectId }, signal });
  },
};
