// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import { canvasApi, type NodeHistoryEntry } from '@web/data/api/canvas';

/**
 * Page size used before the `nodeHistoryPageSize` knob loads (or if the limits
 * fetch fails) — mirrors the server default so the degraded page matches.
 */
const HISTORY_PAGE_SIZE_FALLBACK = 20;

/**
 * The React Query key for a node's history, shared by the query and the
 * content-change refetch effect so they target the same cache entry.
 * @param projectId - Project the node belongs to.
 * @param nodeId - The node id (or a sentinel when no panel is open).
 * @returns The stable query key tuple.
 */
function historyKey(
  projectId: string,
  nodeId: string,
): readonly ['node-history', string, string] {
  return ['node-history', projectId, nodeId];
}

/** What {@link useNodeHistory} returns to the panel. */
export interface UseNodeHistory {
  /** Loaded rows, newest first, deduped by id. */
  entries: NodeHistoryEntry[];
  /** Total rows matching the node (from the first page). */
  total: number;
  /**
   * No result yet — the first page is loading OR paused (offline). The panel is
   * hidden in this state (defer-until-data). `isLoading` alone misses the paused
   * case (`isLoading = isPending && isFetching`, and an offline pause has
   * `isFetching` false), so this is `isPending` (`status === 'pending'` = no
   * data), which covers both loading and paused — Gate-2 caught the paused gap.
   */
  isPending: boolean;
  /**
   * The FIRST page load errored (errored with no data). The panel is not shown
   * at all in this state — the caller toasts + closes (user 2026-07-22: never
   * flash a skeleton; show the panel only once there is a result). A LATER
   * refetch error keeps the already-loaded data instead (not this flag).
   */
  isLoadingError: boolean;
  /** Another (older) page is available. */
  hasNextPage: boolean;
  /** A next-page fetch is in flight. */
  isFetchingNextPage: boolean;
  /** Load the next (older) page — the infinite-scroll sentinel calls this. */
  fetchNextPage: () => void;
}

/**
 * Loads a node's history (generations + uploads), paginated + deduped, for the
 * recovery panel (#1619). Newest-first, infinite scroll via offset pages; rows
 * are deduped by id because a concurrent head-insert can shift the offset
 * window and repeat a row (spec §5.5).
 *
 * While the panel is open, a change to the node's live content that matches no
 * loaded row invalidates the first page ONCE — a generation that completed
 * while browsing lands at the top and the total refreshes. The effect keys
 * ONLY on `currentContent` and reads the loaded rows through a ref (never a
 * dep), so it fires once per distinct content value and never in a
 * refetch → new-data → effect-reruns loop (spec §4, Gate-1 R2 fix).
 * @param nodeId - The host node id, or null when no history panel is open.
 * @param projectId - Project the node belongs to.
 * @param currentContent - The node's live `data.content`; drives the refetch.
 * @returns The deduped entries, total, and paging state.
 */
export function useNodeHistory(
  nodeId: string | null,
  projectId: string,
  currentContent: string | null | undefined,
): UseNodeHistory {
  const query = useInfiniteQuery({
    queryKey: historyKey(projectId, nodeId ?? '__none__'),
    queryFn: async ({ pageParam }) => {
      const limits = await canvasApi.fetchLimits().catch(() => null);
      const limit = limits?.nodeHistoryPageSize ?? HISTORY_PAGE_SIZE_FALLBACK;
      return canvasApi.listNodeHistory(nodeId as string, projectId, {
        limit,
        offset: pageParam,
      });
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.entries.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    enabled: nodeId != null,
  });

  // Flatten pages + dedup by id (offset pagination can repeat a row when a new
  // row is inserted at the head between page fetches — §5.5).
  const entries = React.useMemo(() => {
    const seen = new Set<string>();
    const out: NodeHistoryEntry[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const e of page.entries) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          out.push(e);
        }
      }
    }
    return out;
  }, [query.data]);

  const total = query.data?.pages[0]?.total ?? 0;

  // Edge-triggered refetch (§4, loop-proof). Read the loaded rows via a ref,
  // NOT a dep: putting `entries` / `query.data` in the dep array would re-run
  // this on every refetch (new data identity) and loop forever. Keying only on
  // `currentContent` fires it once per distinct value.
  const queryClient = useQueryClient();
  const entriesRef = React.useRef(entries);
  entriesRef.current = entries;
  React.useEffect(() => {
    if (nodeId == null || currentContent == null) return;
    const inLoaded = entriesRef.current.some(
      (e) => e.content === currentContent,
    );
    if (!inLoaded) {
      void queryClient.invalidateQueries({
        queryKey: historyKey(projectId, nodeId),
      });
    }
  }, [currentContent, nodeId, projectId, queryClient]);

  // Stable callback so the panel's React.memo bails and its IntersectionObserver
  // effect doesn't re-subscribe every render. React Query's fetchNextPage is a
  // stable ref — destructure it so exhaustive-deps tracks the method identity
  // (not the whole `query` object, which changes each update).
  const { fetchNextPage: queryFetchNextPage } = query;
  const fetchNextPage = React.useCallback((): void => {
    void queryFetchNextPage();
  }, [queryFetchNextPage]);

  return {
    entries,
    total,
    isPending: query.isPending,
    isLoadingError: query.isLoadingError,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage,
  };
}
