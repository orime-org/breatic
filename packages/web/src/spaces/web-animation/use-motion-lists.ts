// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { useInfiniteQuery, type InfiniteData, type UseInfiniteQueryResult } from '@tanstack/react-query';
import type { WebAnimationListPage, WebAnimationListScope, WebAnimationRowView } from '@breatic/shared/space-content';

import { spaceTasksQueryKey } from '@web/data/api/scene';
import { timelineApi } from '@web/data/api/timeline';
import type { MotionTab } from '@web/spaces/web-animation/motion-panels';

/** One list's pages as React Query holds them. */
type ListQuery = UseInfiniteQueryResult<InfiniteData<WebAnimationListPage, string | undefined>>;

/** Any paged list of executions as React Query holds it: a Motion list or the Timeline picker's results. */
interface PagedRows {
  data?: { pages: readonly WebAnimationListPage[] };
}

/** One tab of the execution list: this Space's rows, then those made in a Timeline before Motion. */
export interface MotionTabList {
  own: ListQuery;
  legacy: ListQuery;
  /** Both lists' loaded rows, this Space's first. */
  rows: readonly WebAnimationRowView[];
  /** Reads both lists again. */
  retry: () => void;
}

/** The Motion Space's lists (#1490 design §4.4, §7.1), one per execution-list tab. */
export interface MotionLists {
  succeeded: MotionTabList;
  running: MotionTabList;
  failed: MotionTabList;
  /** Every row loaded in any list, by id. */
  byId: ReadonlyMap<string, WebAnimationRowView>;
  /** How many rows each tab holds, across this Space's own rows and the Timeline-made group. */
  totals: NonNullable<WebAnimationListPage['totals']>;
}

/**
 * The key one list is cached under: inside the Space-task key, so a change version in the Space's document
 * (`SpaceTasksWatcher`) reads it again.
 * @param projectId - The Project.
 * @param spaceId - The Motion Space.
 * @param scope - Which list.
 * @param group - Which tab.
 * @returns The key.
 * @throws {never} Never.
 */
export function motionListQueryKey(projectId: string, spaceId: string, scope: WebAnimationListScope, group: MotionTab): readonly unknown[] {
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
export function useMotionList(projectId: string, spaceId: string, scope: WebAnimationListScope, group: MotionTab, enabled = true): ListQuery {
  const queryKey = React.useMemo(() => motionListQueryKey(projectId, spaceId, scope, group), [projectId, spaceId, scope, group]);
  const queryFn = React.useCallback(({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
    timelineApi.listSpaceExecutions({ projectId, spaceId, scope, group, cursor: pageParam }, signal), [projectId, spaceId, scope, group]);
  const query: ListQuery = useInfiniteQuery({
    queryKey, queryFn, enabled,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  // React Query answers a new result object on every render; the same one is kept while nothing a list reads changed,
  // so the panels the lists reach skip the renders the play clock causes.
  const { data, status, fetchStatus, error, hasNextPage, isFetchingNextPage, isFetchNextPageError } = query;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the keys are every field the lists read; the methods are stable
  return React.useMemo(() => query, [data, status, fetchStatus, error, hasNextPage, isFetchingNextPage, isFetchNextPageError]);
}

/**
 * The rows of a list's loaded pages.
 * @param query - The list.
 * @returns Its rows, newest first.
 * @throws {never} Never.
 */
export function rowsOf(query: PagedRows): WebAnimationRowView[] {
  return query.data?.pages.flatMap((page) => page.rows) ?? [];
}

/**
 * One tab from its two lists: their rows in order and one retry for both.
 * @param own - This Space's list.
 * @param legacy - The Timeline-made group's list.
 * @returns The tab.
 * @throws {never} Never.
 */
function useTabList(own: ListQuery, legacy: ListQuery): MotionTabList {
  const rows = React.useMemo(() => [...rowsOf(own), ...rowsOf(legacy)], [own, legacy]);
  const { refetch: refetchOwn } = own;
  const { refetch: refetchLegacy } = legacy;
  const retry = React.useCallback((): void => { void refetchOwn(); void refetchLegacy(); }, [refetchOwn, refetchLegacy]);
  return React.useMemo(() => ({ own, legacy, rows, retry }), [own, legacy, rows, retry]);
}

/**
 * A Motion Space's six lists: its own and the Timeline-made group, each in Completed, In progress and Failed. All six
 * are keyed under the Space, so one change in its document reads them all again.
 * @param projectId - The Project.
 * @param spaceId - The Motion Space.
 * @returns The lists.
 * @throws {never} Never.
 */
export function useMotionLists(projectId: string, spaceId: string): MotionLists {
  const ownSucceeded = useMotionList(projectId, spaceId, 'space', 'succeeded');
  const ownRunning = useMotionList(projectId, spaceId, 'space', 'running');
  const ownFailed = useMotionList(projectId, spaceId, 'space', 'failed');
  const legacySucceeded = useMotionList(projectId, spaceId, 'timeline', 'succeeded');
  const legacyRunning = useMotionList(projectId, spaceId, 'timeline', 'running');
  const legacyFailed = useMotionList(projectId, spaceId, 'timeline', 'failed');
  const byId = React.useMemo(() => {
    const map = new Map<string, WebAnimationRowView>();
    // A run only moves towards its end and never back, so the ended lists go last and their copy of a row wins over a
    // list not yet read again since it ended.
    for (const query of [ownRunning, legacyRunning, ownFailed, legacyFailed, ownSucceeded, legacySucceeded]) for (const row of rowsOf(query)) map.set(row.id, row);
    return map;
  }, [ownSucceeded, legacySucceeded, ownRunning, legacyRunning, ownFailed, legacyFailed]);
  const own = ownSucceeded.data?.pages[0]?.totals;
  const legacy = legacySucceeded.data?.pages[0]?.totals;
  const totals = React.useMemo(() => ({
    running: (own?.running ?? 0) + (legacy?.running ?? 0),
    succeeded: (own?.succeeded ?? 0) + (legacy?.succeeded ?? 0),
    failed: (own?.failed ?? 0) + (legacy?.failed ?? 0),
  }), [own, legacy]);
  const succeeded = useTabList(ownSucceeded, legacySucceeded);
  const running = useTabList(ownRunning, legacyRunning);
  const failed = useTabList(ownFailed, legacyFailed);
  return React.useMemo(() => ({ succeeded, running, failed, byId, totals }), [succeeded, running, failed, byId, totals]);
}
