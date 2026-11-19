// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { TIMELINE_PREVIEW_DEFAULTS, type TimelineClientLimits, type TimelinePreviewSyncLimits } from '@breatic/shared';

import { timelineApi } from '@web/data/api/timeline';

/**
 * The read of the Timeline configuration this Project's members may read, for a control that waits while it is read
 * and says so when it failed.
 * @param projectId - The Project.
 * @param enabled - Whether to read it at all.
 * @returns The read.
 * @throws {never} Never.
 */
export function useTimelineLimitsQuery(projectId: string, enabled = true): UseQueryResult<TimelineClientLimits> {
  const queryKey = React.useMemo(() => ['timeline-limits', projectId], [projectId]);
  const queryFn = React.useCallback(({ signal }: { signal: AbortSignal }) => timelineApi.limits(projectId, signal), [projectId]);
  return useQuery({ queryKey, queryFn, staleTime: Infinity, enabled });
}

/**
 * The Timeline configuration this Project's members may read: creation defaults, media paging and the web-animation
 * dialog bounds and preview timings. It does not change while the page is open.
 * @param projectId - The Project.
 * @param enabled - Whether to read them at all.
 * @returns The limits once read.
 * @throws {never} Never.
 */
export function useTimelineLimits(projectId: string, enabled = true): TimelineClientLimits | undefined {
  return useTimelineLimitsQuery(projectId, enabled).data;
}

/**
 * The multi-video preview sync thresholds (#1410 design §6.4): the shared defaults until the limits arrive.
 * @param projectId - The Project.
 * @param enabled - Whether to read the limits at all.
 * @returns The thresholds.
 * @throws {never} Never.
 */
export function useTimelinePreviewLimits(projectId: string, enabled = true): TimelinePreviewSyncLimits {
  return useTimelineLimits(projectId, enabled)?.preview ?? TIMELINE_PREVIEW_DEFAULTS;
}
