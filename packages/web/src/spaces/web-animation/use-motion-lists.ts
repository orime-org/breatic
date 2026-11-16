// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useInfiniteQuery, useQueryClient, type InfiniteData, type UseInfiniteQueryResult } from '@tanstack/react-query';
import type { WebAnimationRowView } from '@breatic/shared/space-content';

import { spaceTasksQueryKey } from '@web/data/api/scene';
import { timelineApi, type SpaceExecutionPage, type SpaceExecutionQuery } from '@web/data/api/timeline';
import type { MotionTab } from '@web/spaces/web-animation/motion-panels';

/** One list's pages as React Query holds them. */
type ListQuery = UseInfiniteQueryResult<InfiniteData<SpaceExecutionPage, string | undefined>>;

/** One tab of the execution list: this Space's rows, then those made in a Timeline before Motion. */
export interface MotionTabList {
  own: ListQuery;
  legacy: ListQuery;
}

/** The Motion Space's lists (#1490 design §4.4, §7.1). */
export interface MotionLists {
  done: MotionTabList;
  running: MotionTabList;
  /** Every row loaded in any list, by id. */
  byId: ReadonlyMap<string, WebAnimationRowView>;
  /** How many rows each tab holds, across both groups. */
  totals: { done: number; inProgress: number };
  /** Whether the first page of each list has been read. */
  loaded: boolean;
}

/**
 * The key one list is cached under: inside the Space-task key, so the page's Space-task signal refetches it.
 * @param projectId - The Project.
 * @param spaceId - The Motion Space.
 * @param scope - Which list.
 * @param group - Which tab.
 * @returns The key.
 * @throws {never} Never.
 */
export function motionListQueryKey(projectId: string, spaceId: string, scope: SpaceExecutionQuery['scope'], group: MotionTab): readonly unknown[] {
  return [...spaceTasksQueryKey(projectId, spaceId), 'motion-list', scope, group];
}

/**
 * One list, paged; the in-progress lists poll while they hold a row.
 * @param projectId - The Project.
 * @param spaceId - The Motion Space.
 * @param scope - Which list.
 * @param group - Which tab.
 * @param refreshMs - The polling interval for an unfinished list.
 * @param enabled - Whether to read it.
 * @returns The query.
 * @throws {never} Never.
 */
export function useMotionList(projectId: string, spaceId: string, scope: SpaceExecutionQuery['scope'], group: MotionTab, refreshMs: number | undefined, enabled = true): ListQuery {
  const queryKey = React.useMemo(() => motionListQueryKey(projectId, spaceId, scope, group), [projectId, spaceId, scope, group]);
  const queryFn = React.useCallback(({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
    timelineApi.listSpaceExecutions({ projectId, spaceId, scope, group, cursor: pageParam }, signal), [projectId, spaceId, scope, group]);
  const refetchInterval = React.useCallback((query: { state: { data?: InfiniteData<SpaceExecutionPage, string | undefined> } }): number | false =>
    group === 'running' && refreshMs !== undefined && (query.state.data?.pages[0]?.rows.length ?? 0) > 0 ? refreshMs : false, [group, refreshMs]);
  return useInfiniteQuery({
    queryKey, queryFn, refetchInterval, enabled,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

/**
 * The rows of a list's loaded pages.
 * @param query - The list.
 * @returns Its rows, newest first.
 * @throws {never} Never.
 */
export function rowsOf(query: ListQuery): WebAnimationRowView[] {
  return query.data?.pages.flatMap((page) => page.rows) ?? [];
}

/**
 * A Motion Space's four lists: its own and the Timeline-made group, each in Completed and In Progress. A row that
 * leaves In Progress has ended, so Completed is read again then.
 * @param projectId - The Project.
 * @param spaceId - The Motion Space.
 * @param refreshMs - The polling interval while a row is unfinished.
 * @returns The lists.
 * @throws {never} Never.
 */
export function useMotionLists(projectId: string, spaceId: string, refreshMs: number | undefined): MotionLists {
  const queryClient = useQueryClient();
  const ownDone = useMotionList(projectId, spaceId, 'space', 'done', refreshMs);
  const ownRunning = useMotionList(projectId, spaceId, 'space', 'running', refreshMs);
  const legacyDone = useMotionList(projectId, spaceId, 'timeline', 'done', refreshMs);
  const legacyRunning = useMotionList(projectId, spaceId, 'timeline', 'running', refreshMs);
  const runningIds = React.useMemo(() => [...rowsOf(ownRunning), ...rowsOf(legacyRunning)].map((row) => row.id).join(','), [ownRunning, legacyRunning]);
  const previous = React.useRef(runningIds);
  React.useEffect(() => {
    const before = previous.current.split(',').filter(Boolean);
    previous.current = runningIds;
    const now = new Set(runningIds.split(','));
    if (before.some((id) => !now.has(id))) {
      void queryClient.invalidateQueries({ queryKey: motionListQueryKey(projectId, spaceId, 'space', 'done') });
      void queryClient.invalidateQueries({ queryKey: motionListQueryKey(projectId, spaceId, 'timeline', 'done') });
    }
  }, [runningIds, queryClient, projectId, spaceId]);
  const byId = React.useMemo(() => {
    const map = new Map<string, WebAnimationRowView>();
    for (const query of [ownDone, legacyDone, ownRunning, legacyRunning]) for (const row of rowsOf(query)) map.set(row.id, row);
    return map;
  }, [ownDone, legacyDone, ownRunning, legacyRunning]);
  const own = ownDone.data?.pages[0]?.totals;
  const legacy = legacyDone.data?.pages[0]?.totals;
  const totals = React.useMemo(() => ({
    done: (own?.done ?? 0) + (legacy?.done ?? 0),
    inProgress: (own?.inProgress ?? 0) + (legacy?.inProgress ?? 0),
  }), [own, legacy]);
  const done = React.useMemo(() => ({ own: ownDone, legacy: legacyDone }), [ownDone, legacyDone]);
  const running = React.useMemo(() => ({ own: ownRunning, legacy: legacyRunning }), [ownRunning, legacyRunning]);
  const loaded = ownDone.isSuccess && legacyDone.isSuccess && ownRunning.isSuccess && legacyRunning.isSuccess;
  return { done, running, byId, totals, loaded };
}
