// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProjectAssetPage, ProjectRegisteredAsset, TimelineClientLimits, TimelineExecution, TimelineWebResolution } from '@breatic/shared';
import type { z } from 'zod';
import type { WebAnimationExecutionRequestSchema, WebAnimationRowView } from '@breatic/shared/space-content';
import { apiGet, apiPost, request, runOnceRequest } from '@web/data/api/request';
import type { ApiEnvelope } from '@web/data/api/types';

/** What a Motion Space submits: one kinded request, keyed by the Project. */
export type WebAnimationAcceptBody = Extract<z.input<typeof WebAnimationExecutionRequestSchema>, { kind: string }> & { projectId: string };

/** A request as a Motion Space builds it, before the Project, Space and action are added. */
export type WebAnimationAcceptRequest = WebAnimationAcceptBody extends infer Body
  ? Body extends unknown ? Omit<Body, 'projectId' | 'spaceId' | 'actionId'> : never
  : never;

/** What accepting answered: the row, and whether this press created it (201) or found it (200). */
export interface AcceptedWebAnimation {
  row: WebAnimationRowView;
  created: boolean;
}

/** One page of a Motion list, with how many rows each group holds. */
export interface SpaceExecutionPage {
  rows: WebAnimationRowView[];
  nextCursor: string | null;
  totals: { done: number; inProgress: number };
}

/** Which Motion list to read: this Space's own, or the group made in a Timeline before Motion existed. */
export interface SpaceExecutionQuery {
  projectId: string;
  spaceId: string;
  scope: 'space' | 'timeline';
  group: 'done' | 'running';
  cursor?: string;
}

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
   * One page of a Motion Space's list (#1490 design §4.4).
   * @param query - Which list, group and page.
   * @param signal - Cancellation for this read.
   * @returns The page and the group totals.
   * @throws {ApiException} When the request fails.
   */
  listSpaceExecutions(query: SpaceExecutionQuery, signal?: AbortSignal): Promise<SpaceExecutionPage> {
    return apiGet('/timeline/space-executions', { params: query, signal });
  },
  /**
   * One page of the Project's web-animation results, for the Timeline's picker.
   * @param projectId - The Project.
   * @param cursor - The previous page's cursor.
   * @param signal - Cancellation for this read.
   * @returns The page.
   * @throws {ApiException} When the request fails.
   */
  listResults(projectId: string, cursor?: string, signal?: AbortSignal): Promise<SpaceExecutionPage> {
    return apiGet('/timeline/results', { params: { projectId, cursor }, signal });
  },
  /**
   * One execution this Project holds, as the Motion Space asking sees it.
   * @param projectId - The Project.
   * @param spaceId - The Motion Space.
   * @param executionId - The execution.
   * @param signal - Cancellation for this read.
   * @returns Its row view.
   * @throws {ApiException} When it is not found or the request fails.
   */
  getExecution(projectId: string, spaceId: string, executionId: string, signal?: AbortSignal): Promise<WebAnimationRowView> {
    return apiGet(`/timeline/executions/${executionId}`, { params: { projectId, spaceId }, signal });
  },
  /**
   * Accept a create, modify or export once; a resend with the same key answers the same row.
   * @param body - The request.
   * @param key - The press's `Idempotency-Key`.
   * @returns The row, and whether this press created it.
   * @throws {ApiException} When it is refused or the request fails.
   */
  async acceptExecution(body: WebAnimationAcceptBody, key: string): Promise<AcceptedWebAnimation> {
    const res = await request.post<ApiEnvelope<WebAnimationRowView>>('/timeline/executions', body, runOnceRequest(key));
    return { row: res.data.data, created: res.status === 201 };
  },
  /**
   * Ask an execution to stop.
   * @param executionId - The execution.
   * @param projectId - The Project asking.
   * @param key - The press's `Idempotency-Key`.
   * @returns The execution after the request.
   * @throws {ApiException} When it is refused or the request fails.
   */
  cancelExecution(executionId: string, projectId: string, key: string): Promise<TimelineExecution> {
    return apiPost(`/timeline/executions/${executionId}/cancel`, { projectId }, runOnceRequest(key));
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
