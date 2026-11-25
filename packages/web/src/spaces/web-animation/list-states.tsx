// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The states every web-animation list shares (#1490 design §7.3, §8.2): the Motion preview, its execution list and
 * the Timeline's "Add web animation" picker read one rule and draw one wait, one failure and one Load more.
 */

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';

/** The part of a list query that decides what the list shows. */
interface ListStateQuery {
  isPending: boolean;
  isLoadingError: boolean;
}

/** What a list shows: the wait, its whole-list failure, or what it holds. */
export type ListShows = 'pending' | 'failed' | 'ready';

/**
 * What a list built from one or more queries shows: the wait only before every query has its first answer, the
 * whole-list failure only when a first read failed, and otherwise what it holds, so a failed background read or Load
 * more keeps the rows or the empty state already on screen.
 * @param queries - The list's queries.
 * @returns What it shows.
 * @throws {never} Never.
 */
export function listShows(...queries: readonly ListStateQuery[]): ListShows {
  if (queries.some((query) => query.isPending)) return 'pending';
  return queries.some((query) => query.isLoadingError) ? 'failed' : 'ready';
}

/**
 * A list's wait before its first answer: three row-sized skeletons.
 * @param props - Where it sits.
 * @param props.className - Its padding in the list.
 * @returns The wait.
 * @throws {never} Never.
 */
export function ListPending({ className }: { className?: string }): React.JSX.Element {
  return <div className={cn('flex flex-col gap-2', className)}>{[0, 1, 2].map((index) => <Skeleton key={index} className='h-12 w-full' />)}</div>;
}

/** A list's whole-list failure. */
interface ListLoadErrorProps {
  /** What failed, in the list's own words. */
  message: string;
  onRetry: () => void;
  testId?: string;
}

/**
 * The whole-list failure: what failed and Retry. A retried first read is pending again, so the list shows its own
 * loading state while it reads and this failure is gone.
 * @param props - The failure.
 * @param props.message - What failed.
 * @param props.onRetry - Reads the list again.
 * @param props.testId - The Retry button's test id.
 * @returns The failure.
 * @throws {never} Never.
 */
export function ListLoadError({ message, onRetry, testId }: ListLoadErrorProps): React.JSX.Element {
  const t = useTranslation();
  return <div className='flex flex-col items-center gap-2 p-6 text-xs'>
    <span className='text-status-error-foreground'>{message}</span>
    <Button type='button' data-testid={testId} variant='outline' size='sm' onClick={onRetry}>{t('timeline.retry')}</Button>
  </div>;
}

/** The paging part of a list query. */
interface LoadMoreQuery {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => Promise<unknown>;
}

/**
 * A list's Load more: drawn while a next page exists, waiting while it reads, and Retry once that read failed.
 * @param props - The list's paging.
 * @param props.query - Its paging state.
 * @param props.className - Where it sits.
 * @returns The button, or nothing at the end of the list.
 * @throws {never} Never.
 */
export function LoadMoreButton({ query, className }: { query: LoadMoreQuery; className?: string }): React.JSX.Element | null {
  const t = useTranslation();
  const { fetchNextPage } = query;
  const more = React.useCallback((): void => { void fetchNextPage(); }, [fetchNextPage]);
  if (!query.hasNextPage) return null;
  return <Button type='button' variant='outline' size='sm' className={cn('w-full', className)} loading={query.isFetchingNextPage} onClick={more}>
    {t(query.isFetchNextPageError ? 'timeline.retry' : 'timeline.webAnimation.picker.loadMore')}
  </Button>;
}
