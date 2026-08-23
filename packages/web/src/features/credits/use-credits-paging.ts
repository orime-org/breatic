// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { CreditPage } from '@breatic/shared';

import { CreditsScrollerContext } from '@web/features/credits/CreditsOverlay';
import { useScrolledToEnd } from '@web/lib/use-scrolled-to-end';

/** What a paging section needs to ask for its pages. */
interface CreditsPagingOptions<T> {
  /** The query's key, already carrying the account. */
  queryKey: readonly unknown[];
  /** Reads one page, given the previous page's cursor. */
  read: (cursor: string | undefined) => Promise<CreditPage<T>>;
  /** Whether to read at all. */
  enabled: boolean;
}

/** Everything a paging section renders from. */
interface CreditsPagingResult<T> {
  /** Every row read so far, in order. */
  rows: T[];
  /** The first page has not arrived. */
  isPending: boolean;
  /** Nothing arrived at all. */
  isError: boolean;
  /** A further page is on its way. */
  isFetchingNextPage: boolean;
  /** There are more pages to read. */
  hasNextPage: boolean;
  /** Goes on an empty element after the last row. */
  sentinelRef: (node: HTMLElement | null) => void;
}

/**
 * Read a credits list one page at a time, fetching the next as the reader
 * nears the end of the overlay's panel.
 *
 * The element being watched is the overlay's, not this section's: seven
 * sections share one scroll container and only one of them is mounted, so the
 * sentinel belongs to whichever is showing while the scroller stays put.
 * @param options - The query key, the read, and whether to run it.
 * @param options.queryKey - The query's key, already carrying the account.
 * @param options.read - Reads one page, given the previous page's cursor.
 * @param options.enabled - Whether to read at all.
 * @returns The rows read so far, the states, and the sentinel to place.
 */
export function useCreditsPaging<T>({
  queryKey,
  read,
  enabled,
}: CreditsPagingOptions<T>): CreditsPagingResult<T> {
  const scroller = React.useContext(CreditsScrollerContext);
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      read(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: CreditPage<T>) => last.nextCursor ?? undefined,
    enabled,
  });

  const { fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } =
    query;
  // Stable, so the watcher's effect does not re-subscribe every render.
  const loadMore = React.useCallback((): void => {
    void fetchNextPage();
  }, [fetchNextPage]);

  const rows = React.useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );

  const { scrollerRef, sentinelRef } = useScrolledToEnd({
    enabled: hasNextPage && !isFetchingNextPage,
    onReachEnd: loadMore,
    itemCount: rows.length,
    // A page that did not arrive stops the watcher until the reader scrolls
    // again. `isFetchNextPageError` and not `isError`: a first page that did
    // arrive leaves the query successful, which is exactly the failure this
    // is here to notice.
    failed: isFetchNextPageError,
  });

  React.useEffect(() => {
    scrollerRef(scroller);
  }, [scroller, scrollerRef]);

  return {
    rows,
    isPending: query.isPending,
    isError: query.isError,
    isFetchingNextPage,
    hasNextPage,
    sentinelRef,
  };
}
