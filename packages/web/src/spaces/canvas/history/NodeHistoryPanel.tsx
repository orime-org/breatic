// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { History, Loader2, RotateCw, X } from 'lucide-react';
import * as React from 'react';

import { ScrollArea } from '@web/components/ui/scroll-area';
import type { NodeHistoryEntry } from '@web/data/api/canvas';
import { useTranslation } from '@web/i18n/use-translation';
import {
  NodeHistoryRow,
  type HistoryModality,
} from '@web/spaces/canvas/history/NodeHistoryRow';

/** Props for {@link NodeHistoryPanel}. */
export interface NodeHistoryPanelProps {
  /** Loaded rows, newest first, deduped. */
  entries: NodeHistoryEntry[];
  /** Total rows matching the node (for the header count). */
  total: number;
  /** The host node's modality. */
  modality: HistoryModality;
  /** Id of the row to tag "current" (the node's live content), or null. */
  currentEntryId: string | null;
  /** First page still loading. */
  isLoading: boolean;
  /** The query errored. */
  isError: boolean;
  /** An older page is available. */
  hasNextPage: boolean;
  /** A next-page fetch is in flight. */
  isFetchingNextPage: boolean;
  /** Load the next (older) page — the scroll sentinel calls this. */
  onLoadMore: () => void;
  /** Retry after an error. */
  onRetry: () => void;
  /** Restore an entry onto the node. */
  onRestore: (entry: NodeHistoryEntry) => void;
  /** Close the panel. */
  onClose: () => void;
}

/**
 * The node-history browse + restore panel body (#1619) — presentational. Shows
 * a header with the total, then loading skeletons / an error retry / an empty
 * hint / the scrollable row list with an infinite-scroll sentinel. Restore and
 * paging are handled by the caller (the container owns the query + gate).
 * @param root0 - Component props.
 * @param root0.entries - Loaded rows.
 * @param root0.total - Total rows for the header count.
 * @param root0.modality - Host node modality.
 * @param root0.currentEntryId - Row id to tag "current", or null.
 * @param root0.isLoading - First page loading.
 * @param root0.isError - Query errored.
 * @param root0.hasNextPage - An older page is available.
 * @param root0.isFetchingNextPage - A page fetch is in flight.
 * @param root0.onLoadMore - Load the next page.
 * @param root0.onRetry - Retry after an error.
 * @param root0.onRestore - Restore an entry onto the node.
 * @param root0.onClose - Close the panel.
 * @returns The panel body (rendered inside the container's `NodeToolbar`).
 */
export const NodeHistoryPanel = React.memo(function NodeHistoryPanel({
  entries,
  total,
  modality,
  currentEntryId,
  isLoading,
  isError,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onRetry,
  onRestore,
  onClose,
}: NodeHistoryPanelProps): React.JSX.Element {
  const t = useTranslation();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const sentinelRef = React.useRef<HTMLDivElement>(null);

  // Infinite scroll: observe a sentinel against the ScrollArea viewport (Radix
  // stamps `[data-radix-scroll-area-viewport]` on the actual scroller, so we
  // query it rather than extend the shared primitive). Re-subscribes when the
  // paging state changes; onLoadMore is stable (the hook useCallbacks it).
  React.useEffect(() => {
    const sentinel = sentinelRef.current;
    const viewport = scrollRef.current?.querySelector(
      '[data-radix-scroll-area-viewport]',
    );
    if (!sentinel || !viewport || !hasNextPage) return;
    const io = new IntersectionObserver(
      (obsEntries) => {
        if (obsEntries[0]?.isIntersecting && !isFetchingNextPage) onLoadMore();
      },
      { root: viewport, rootMargin: '80px' },
    );
    io.observe(sentinel);
    return () => {
      io.disconnect();
    };
  }, [hasNextPage, isFetchingNextPage, onLoadMore]);

  return (
    <div className='flex w-[min(344px,92vw)] flex-col rounded-overlay border border-border bg-popover text-popover-foreground shadow-md'>
      <div className='flex items-center justify-between px-3 py-2.5'>
        <div className='flex items-baseline gap-2'>
          <span className='text-sm font-semibold'>
            {t('canvas.history.title')}
          </span>
          {total > 0 ? (
            <span className='text-2xs tabular-nums text-muted-foreground'>
              {t('canvas.history.count', { count: total })}
            </span>
          ) : null}
        </div>
        <button
          type='button'
          data-testid='node-history-close'
          aria-label={t('canvas.history.close')}
          onClick={onClose}
          className='flex h-6 w-6 items-center justify-center rounded-content-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        >
          <X className='h-3.5 w-3.5' aria-hidden='true' />
        </button>
      </div>

      {isLoading ? (
        <div className='flex flex-col gap-1 px-1.5 pb-2' data-testid='node-history-loading'>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className='flex items-center gap-2.5 px-1.5 py-1.5'
            >
              <div className='h-[46px] w-[46px] shrink-0 animate-pulse rounded-content-sm bg-muted' />
              <div className='flex flex-1 flex-col gap-1.5'>
                <div className='h-3 w-2/3 animate-pulse rounded-content-sm bg-muted' />
                <div className='h-2.5 w-1/3 animate-pulse rounded-content-sm bg-muted' />
              </div>
            </div>
          ))}
        </div>
      ) : isError ? (
        <div
          className='flex flex-col items-center gap-2 px-6 py-7 text-center'
          data-testid='node-history-error'
        >
          <span className='text-xs text-status-error'>
            {t('canvas.history.loadError')}
          </span>
          <button
            type='button'
            onClick={onRetry}
            className='inline-flex items-center gap-1 rounded-content-sm border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground'
          >
            <RotateCw className='h-3 w-3' aria-hidden='true' />
            {t('canvas.history.retry')}
          </button>
        </div>
      ) : entries.length === 0 ? (
        <div
          className='flex flex-col items-center gap-2.5 px-6 py-7 text-center'
          data-testid='node-history-empty'
        >
          <History className='h-8 w-8 text-muted-foreground' aria-hidden='true' />
          <span className='text-sm font-semibold'>
            {t('canvas.history.empty.title')}
          </span>
          <span className='max-w-[246px] text-xs leading-relaxed text-muted-foreground'>
            {t('canvas.history.empty.hint')}
          </span>
        </div>
      ) : (
        <div ref={scrollRef}>
          <ScrollArea viewportClassName='max-h-[318px] px-1.5 pb-1.5'>
            <div className='flex flex-col gap-0.5'>
              {entries.map((entry) => (
                <NodeHistoryRow
                  key={entry.id}
                  entry={entry}
                  modality={modality}
                  isCurrent={entry.id === currentEntryId}
                  onRestore={onRestore}
                />
              ))}
            </div>
            <div ref={sentinelRef} aria-hidden='true' />
            <div className='flex items-center justify-center py-2 text-2xs tracking-wider text-muted-foreground'>
              {isFetchingNextPage ? (
                <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden='true' />
              ) : !hasNextPage ? (
                <span>· {t('canvas.history.end')} ·</span>
              ) : null}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
});
