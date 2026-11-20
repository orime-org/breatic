// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { TimelineExecutionRow } from '@breatic/shared';

import { spaceTasksQueryKey } from '@web/data/api/scene';
import { timelineApi } from '@web/data/api/timeline';

/**
 * The key one Space's execution list is cached under: inside the Space-task key, so a new change version in the
 * Timeline's document (`SpaceTasksWatcher`) reads it again (inner#1711 design §9, #1568).
 * @param projectId - The Project.
 * @param spaceId - The Timeline Space.
 * @returns The key.
 * @throws {never} Never.
 */
export function timelineExecutionsQueryKey(projectId: string, spaceId: string): readonly [string, string, string, 'timeline-executions'] {
  return [...spaceTasksQueryKey(projectId, spaceId), 'timeline-executions'];
}

/**
 * One Space's execution list. It is read again when the Timeline's document records a change, an expiry included,
 * since the worker's sweep announces it; nothing reads it on a timer.
 * @param projectId - The Project.
 * @param spaceId - The Timeline Space.
 * @param options - Query options.
 * @param options.enabled - Whether to read the list at all; false reads nothing.
 * @returns The query.
 * @throws {never} Never.
 */
export function useTimelineExecutions(projectId: string, spaceId: string, { enabled = true }: { enabled?: boolean } = {}): UseQueryResult<TimelineExecutionRow[]> {
  const queryKey = React.useMemo(() => timelineExecutionsQueryKey(projectId, spaceId), [projectId, spaceId]);
  const queryFn = React.useCallback(({ signal }: { signal: AbortSignal }) => timelineApi.listExecutions(projectId, spaceId, signal), [projectId, spaceId]);
  return useQuery({ queryKey, queryFn, enabled });
}
