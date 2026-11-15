// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useQuery, type Query } from '@tanstack/react-query';

import { spaceTasksQueryKey } from '@web/data/api/scene';
import { timelineApi, type SpaceExecutionPage } from '@web/data/api/timeline';
import { useTimelineLimits } from '@web/spaces/timeline/use-timeline-limits';

/**
 * The key a Motion Space's in-progress count is cached under: inside the Space-task key, so the page's Space-task
 * signal refetches it.
 * @param projectId - The Project.
 * @param spaceId - The Motion Space.
 * @returns The key.
 * @throws {never} Never.
 */
export function motionRunningQueryKey(projectId: string, spaceId: string): readonly [string, string, string, 'motion-running'] {
  return [...spaceTasksQueryKey(projectId, spaceId), 'motion-running'];
}

/**
 * How many of a Motion Space's own executions are still in progress, read from its list route; it polls while any is,
 * and the Space-task signal reads it again at once (#1490 design §8.3).
 * @param projectId - The Project.
 * @param spaceId - The Motion Space.
 * @param enabled - Whether this Space is a Motion Space.
 * @returns Whether any is in progress.
 * @throws {never} Never.
 */
export function useMotionRunning(projectId: string, spaceId: string, enabled: boolean): boolean {
  const refreshMs = useTimelineLimits(projectId, enabled)?.webAnimation.sourceRefreshIntervalMs;
  const queryKey = React.useMemo(() => motionRunningQueryKey(projectId, spaceId), [projectId, spaceId]);
  const queryFn = React.useCallback(({ signal }: { signal: AbortSignal }) => timelineApi.listSpaceExecutions({ projectId, spaceId, scope: 'space', group: 'running' }, signal), [projectId, spaceId]);
  const refetchInterval = React.useCallback((query: Query<SpaceExecutionPage>): number | false =>
    refreshMs !== undefined && (query.state.data?.totals.inProgress ?? 0) > 0 ? refreshMs : false, [refreshMs]);
  const count = useQuery({ queryKey, queryFn, refetchInterval, enabled });
  return enabled && (count.data?.totals.inProgress ?? 0) > 0;
}

