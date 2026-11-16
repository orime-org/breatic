// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { TIMELINE_PREVIEW_DEFAULTS, type TimelineClientLimits, type TimelinePreviewSyncLimits } from '@breatic/shared';

import { timelineApi } from '@web/data/api/timeline';

/**
 * The Timeline configuration this Project's members may read: creation defaults, media paging and the web-animation
 * dialog bounds and preview timings. It does not change while the page is open.
 * @param projectId - The Project.
 * @param enabled - Whether to read them at all.
 * @returns The limits once read.
 * @throws {never} Never.
 */
export function useTimelineLimits(projectId: string, enabled = true): TimelineClientLimits | undefined {
  const queryKey = React.useMemo(() => ['timeline-limits', projectId], [projectId]);
  const queryFn = React.useCallback(({ signal }: { signal: AbortSignal }) => timelineApi.limits(projectId, signal), [projectId]);
  return useQuery({ queryKey, queryFn, staleTime: Infinity, enabled }).data;
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
