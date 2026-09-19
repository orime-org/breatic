// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
export function historyKey(
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
   * hidden during a short grace window, then shows a skeleton (#1812
   * defer-then-skeleton). `isLoading` alone misses the paused case
   * (`isLoading = isPending && isFetching`, and an offline pause has `isFetching`
   * false), so this is `isPending` (`status === 'pending'` = no data), which
   * covers both loading and paused — Gate-2 caught the paused gap.
   */
  isPending: boolean;
  /**
   * The FIRST page load errored (errored with no data). The caller shows an
   * in-panel error + retry in this state (#1812, C hybrid — no toast, no close).
   * A LATER refetch error keeps the already-loaded data instead (not this flag).
   */
  isLoadingError: boolean;
  /** Another (older) page is available. */
  hasNextPage: boolean;
  /** A next-page fetch is in flight. */
  isFetchingNextPage: boolean;
  /** Load the next (older) page — the infinite-scroll sentinel calls this. */
  fetchNextPage: () => void;
  /** Re-run the query — the in-panel error's retry button calls this (#1812). */
  retry: () => void;
}

/**
 * Loads a node's history (generations, uploads, snapshots), paginated + deduped, for the
 * recovery panel (#1619). Newest-first, infinite scroll via offset pages; rows
 * are deduped by id because a concurrent head-insert can shift the offset
 * window and repeat a row (spec §5.5).
 *
 * While the panel is open, a run reaching its end invalidates the first page
 * ONCE — it wrote a row, that row belongs at the top, and the rows on screen
 * are one fetch that knows nothing about it. The effect keys ONLY on
 * `settledRuns` and never on the loaded data, so it fires once per run and
 * never in a refetch → new-data → effect-reruns loop (spec §4, Gate-1 R2 fix).
 *
 * Counting settled runs rather than watching the node's content is what makes
 * this the same for every modality: a text node's words are written by the
 * reader too, and a keystroke is not a new row.
 * @param nodeId - The host node id, or null when no history panel is open.
 * @param projectId - Project the node belongs to.
 * @param settledRuns - How many runs on this node have reached an end. Null
 *   before the node's counts have been read; the list then refreshes only on
 *   an explicit invalidation.
 * @returns The deduped entries, total, and paging state.
 */
export function useNodeHistory(
  nodeId: string | null,
  projectId: string,
  settledRuns: number | null,
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

  // Edge-triggered refetch (§4, loop-proof). The count is the only dep, and
  // the loaded data is not one: putting `entries` / `query.data` in the dep
  // array would re-run this on every refetch (new data identity) and loop
  // forever. The first reading opens the panel rather than refetching it —
  // the fetch it would ask for is the one already in flight.
  const queryClient = useQueryClient();
  // The node this reading belongs to travels with it: a different node is a
  // different list, and its first count is that list's opening reading rather
  // than a run that just landed.
  const seen = React.useRef<{ nodeId: string; runs: number } | null>(null);
  React.useEffect(() => {
    if (nodeId == null || settledRuns == null) return;
    const before = seen.current;
    seen.current = { nodeId, runs: settledRuns };
    if (before === null || before.nodeId !== nodeId) return;
    if (settledRuns > before.runs) {
      void queryClient.invalidateQueries({
        queryKey: historyKey(projectId, nodeId),
      });
    }
  }, [settledRuns, nodeId, projectId, queryClient]);

  // Stable callback so the panel's React.memo bails and its IntersectionObserver
  // effect doesn't re-subscribe every render. React Query's fetchNextPage is a
  // stable ref — destructure it so exhaustive-deps tracks the method identity
  // (not the whole `query` object, which changes each update).
  const { fetchNextPage: queryFetchNextPage, refetch: queryRefetch } = query;
  const fetchNextPage = React.useCallback((): void => {
    void queryFetchNextPage();
  }, [queryFetchNextPage]);
  // Stable retry for the in-panel error button (#1812). React Query's refetch
  // is a stable ref — destructure it so the callback identity stays put.
  const retry = React.useCallback((): void => {
    void queryRefetch();
  }, [queryRefetch]);

  return {
    entries,
    total,
    isPending: query.isPending,
    isLoadingError: query.isLoadingError,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage,
    retry,
  };
}
