// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useQuery, useQueryClient, type Query, type UseQueryResult } from '@tanstack/react-query';
import type { TimelineExecutionStatus } from '@breatic/shared';

import { spaceTasksQueryKey } from '@web/data/api/scene';
import { timelineApi, type TimelineExecutionRow } from '@web/data/api/timeline';

const TERMINAL: ReadonlySet<TimelineExecutionStatus> = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

// The longest delay a browser timer keeps; a longer one would fire at once.
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Whether an execution has not ended yet.
 * @param status - Its status.
 * @returns True until it succeeded, failed, was cancelled or expired.
 * @throws {never} Never.
 */
export function timelineExecutionUnfinished(status: TimelineExecutionStatus): boolean {
  return !TERMINAL.has(status);
}

/**
 * The key one Space's execution list is cached under: inside the Space-task key, so the page's Space-task signal
 * refetches it (inner#1711 design §9).
 * @param projectId - The Project.
 * @param spaceId - The Timeline Space.
 * @returns The key.
 * @throws {never} Never.
 */
export function timelineExecutionsQueryKey(projectId: string, spaceId: string): readonly [string, string, string, 'timeline-executions'] {
  return [...spaceTasksQueryKey(projectId, spaceId), 'timeline-executions'];
}

/**
 * One Space's execution list. It refetches on the Space-task signal, polls while an execution is unfinished, and is
 * read again once when the earliest unfinished execution reaches its deadline, so an expiry shows without a signal.
 * @param projectId - The Project.
 * @param spaceId - The Timeline Space.
 * @param refreshMs - The polling interval while an execution is unfinished; none polls nothing.
 * @returns The query.
 * @throws {never} Never.
 */
export function useTimelineExecutions(projectId: string, spaceId: string, refreshMs?: number): UseQueryResult<TimelineExecutionRow[]> {
  const queryClient = useQueryClient();
  const queryKey = React.useMemo(() => timelineExecutionsQueryKey(projectId, spaceId), [projectId, spaceId]);
  const queryFn = React.useCallback(({ signal }: { signal: AbortSignal }) => timelineApi.listExecutions(projectId, spaceId, signal), [projectId, spaceId]);
  const refetchInterval = React.useCallback((query: Query<TimelineExecutionRow[]>): number | false =>
    refreshMs !== undefined && query.state.data?.some((row) => timelineExecutionUnfinished(row.status)) === true ? refreshMs : false, [refreshMs]);
  const list = useQuery({ queryKey, queryFn, refetchInterval });
  // Deadlines already read once; a row the server has not yet marked expired is not read again for the same deadline.
  const passed = React.useRef(new Set<string>());
  const deadline = React.useMemo(() => {
    let earliest: { key: string; at: number } | null = null;
    for (const row of list.data ?? []) {
      const key = `${row.id}:${row.deadlineAt}`;
      const at = new Date(row.deadlineAt).getTime();
      if (!timelineExecutionUnfinished(row.status) || passed.current.has(key) || !Number.isFinite(at)) continue;
      if (earliest === null || at < earliest.at) earliest = { key, at };
    }
    return earliest;
  }, [list.data]);
  React.useEffect(() => {
    if (deadline === null) return;
    const timer = setTimeout(() => {
      passed.current.add(deadline.key);
      void queryClient.invalidateQueries({ queryKey });
    }, Math.min(MAX_TIMER_MS, Math.max(0, deadline.at - Date.now())));
    return () => clearTimeout(timer);
  }, [deadline, queryClient, queryKey]);
  return list;
}
