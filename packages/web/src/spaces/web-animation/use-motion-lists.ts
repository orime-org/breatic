// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useInfiniteQuery, type InfiniteData, type UseInfiniteQueryResult } from '@tanstack/react-query';
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
 * One list, paged. It is read again when the Space's document says an execution changed (`SpaceTasksWatcher`,
 * #1490 design §4.7); nothing polls it.
 * @param projectId - The Project.
 * @param spaceId - The Motion Space.
 * @param scope - Which list.
 * @param group - Which tab.
 * @param enabled - Whether to read it.
 * @returns The query.
 * @throws {never} Never.
 */
export function useMotionList(projectId: string, spaceId: string, scope: SpaceExecutionQuery['scope'], group: MotionTab, enabled = true): ListQuery {
  const queryKey = React.useMemo(() => motionListQueryKey(projectId, spaceId, scope, group), [projectId, spaceId, scope, group]);
  const queryFn = React.useCallback(({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
    timelineApi.listSpaceExecutions({ projectId, spaceId, scope, group, cursor: pageParam }, signal), [projectId, spaceId, scope, group]);
  return useInfiniteQuery({
    queryKey, queryFn, enabled,
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
 * A Motion Space's four lists: its own and the Timeline-made group, each in Completed and In Progress. All four are
 * keyed under the Space, so one change in its document reads them all again.
 * @param projectId - The Project.
 * @param spaceId - The Motion Space.
 * @returns The lists.
 * @throws {never} Never.
 */
export function useMotionLists(projectId: string, spaceId: string): MotionLists {
  const ownDone = useMotionList(projectId, spaceId, 'space', 'done');
  const ownRunning = useMotionList(projectId, spaceId, 'space', 'running');
  const legacyDone = useMotionList(projectId, spaceId, 'timeline', 'done');
  const legacyRunning = useMotionList(projectId, spaceId, 'timeline', 'running');
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
  return { done, running, byId, totals };
}
