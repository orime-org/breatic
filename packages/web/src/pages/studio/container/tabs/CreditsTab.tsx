// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { Skeleton } from '@web/components/ui/skeleton';
import {
  fetchStudioCredits,
  type CreditLedgerView,
  type CreditLotView,
} from '@web/data/api/credits';
import { useTranslation } from '@web/i18n/use-translation';
import { useScrolledToEnd } from '@web/lib/use-scrolled-to-end';
import type { StudioRole } from '@web/pages/studio/shared/studio-types';

interface CreditsTabProps {
  /** The studio being viewed. */
  slug: string;
  /** The viewer's studio role, or `null` for a non-member. */
  studioRole: StudioRole | null;
}

/**
 * Format a credit amount for display.
 * @param value - The amount.
 * @returns The amount with thousands separators and at most two decimals.
 */
function formatAmount(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Format a timestamp as a date.
 * @param iso - An ISO-8601 timestamp.
 * @returns Its date part.
 */
function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * One purchase making up this studio's balance.
 * @param props - The lot.
 * @param props.lot - What was bought and what is left of it.
 * @returns The row.
 */
const LotRow = React.memo(function LotRow({
  lot,
}: {
  lot: CreditLotView;
}): React.JSX.Element {
  const t = useTranslation();
  return (
    <li
      data-testid={`studio-lot-${lot.id}`}
      className='flex items-baseline gap-3 border-t border-border py-2.5 first:border-t-0 first:pt-0 last:pb-0'
    >
      <span className='text-xs text-muted-foreground'>
        {formatDate(lot.createdAt)}
      </span>
      <span className='ml-auto text-right tabular-nums'>
        <span className='block text-sm font-semibold'>
          {formatAmount(lot.remainingCredits)}
        </span>
        <span className='block text-xs text-muted-foreground'>
          {t('studio.container.credits.lotPurchased', {
            amount: formatAmount(lot.purchasedCredits),
          })}
        </span>
      </span>
    </li>
  );
});

/**
 * One movement of the viewer's credits in this studio.
 * @param props - The entry.
 * @param props.entry - What happened.
 * @returns The table row.
 */
const LedgerRow = React.memo(function LedgerRow({
  entry,
}: {
  entry: CreditLedgerView;
}): React.JSX.Element {
  return (
    <tr data-testid={`studio-ledger-${entry.id}`} className='border-t border-border'>
      <td className='py-1.5 text-muted-foreground'>{formatDate(entry.createdAt)}</td>
      <td className='py-1.5'>{entry.actorName ?? '—'}</td>
      <td className='py-1.5 text-muted-foreground'>{entry.projectName ?? '—'}</td>
      <td className='py-1.5 text-muted-foreground'>{entry.model ?? '—'}</td>
      <td className='py-1.5 text-right tabular-nums'>{formatAmount(entry.amount)}</td>
    </tr>
  );
});

/**
 * The Credits tab — what this studio can spend, and where its credits went.
 *
 * The pool belongs to the studio, so every member sees the balance: a guest
 * editing one of its projects spends it. The ledger beside it is taken by
 * payer, so a member reads what their own money paid for here.
 *
 * Buying and refunding are account-level and live in the account's credit
 * overlay; this tab reports.
 * @param props - The studio and the viewer's role.
 * @param props.slug - The studio being viewed.
 * @param props.studioRole - The viewer's studio role.
 * @returns The Credits tab content.
 */
export function CreditsTab({
  slug,
  studioRole,
}: CreditsTabProps): React.JSX.Element {
  const t = useTranslation();

  const query = useInfiniteQuery({
    queryKey: ['studio-credits', slug],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      fetchStudioCredits(slug, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.ledger.nextCursor ?? undefined,
  });

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query;
  // Stable so the scroll watcher's effect does not re-subscribe every render.
  const loadMore = React.useCallback((): void => {
    void fetchNextPage();
  }, [fetchNextPage]);

  const head = query.data?.pages[0];
  const ledgerRows = React.useMemo(
    () => query.data?.pages.flatMap((page) => page.ledger.items) ?? [],
    [query.data],
  );

  const { scrollerRef, sentinelRef } = useScrolledToEnd({
    enabled: hasNextPage && !isFetchingNextPage,
    onReachEnd: loadMore,
    itemCount: ledgerRows.length,
    // A page that did not arrive stops the watcher until the reader scrolls
    // again; without it an end already in view asks for the same page back to
    // back for as long as the failure lasts.
    failed: query.isError,
  });

  if (query.isPending) {
    return (
      <div className='mx-auto flex max-w-3xl flex-col gap-6'>
        <Skeleton className='h-12 w-40' />
        <Skeleton className='h-32 w-full' />
      </div>
    );
  }

  // Only when there is nothing to show. A page that failed after the first one
  // arrived leaves the balance, the purchases and the rows already read in
  // hand, and throwing them away loses more than the failure did.
  if (!head) {
    return (
      <div className='mx-auto max-w-3xl'>
        <p className='text-sm text-muted-foreground'>
          {t('studio.container.credits.loadError')}
        </p>
      </div>
    );
  }

  const isMember = studioRole !== null;

  return (
    <div className='mx-auto flex max-w-3xl flex-col gap-6'>
      <div className='flex items-start gap-4'>
        <div>
          <p className='text-xs text-muted-foreground'>
            {t('studio.container.credits.spendableLabel')}
          </p>
          <p
            data-testid='studio-spendable'
            className='text-3xl font-extrabold leading-[1.1] tracking-[-0.02em] text-foreground'
          >
            {formatAmount(head.spendable ?? 0)}
            <small className='ml-1 align-baseline text-sm font-medium text-muted-foreground'>
              {t('studio.container.credits.unit')}
            </small>
          </p>
          <p className='mt-[3px] text-xs text-muted-foreground'>
            {(head.spendable ?? 0) > 0
              ? t('studio.container.credits.spendableHint')
              : t('studio.container.credits.noneHint')}
          </p>
        </div>
      </div>

      {(head.spendable ?? 0) === 0 && isMember ? (
        <p
          data-testid='studio-credits-unassigned-notice'
          className='rounded-content-sm border border-status-warning-border bg-status-warning-bg px-3 py-2.5 text-sm'
        >
          {t('studio.container.credits.assignPrompt')}
        </p>
      ) : null}

      <section className='rounded-content-md border border-border p-4'>
        <h3 className='mb-3 text-sm font-semibold'>
          {t('studio.container.credits.lotsTitle')}
        </h3>
        {(head.lots ?? []).length === 0 ? (
          <p className='text-sm text-muted-foreground'>
            {t('studio.container.credits.lotsEmpty')}
          </p>
        ) : (
          <ul className='flex flex-col'>
            {(head.lots ?? []).map((lot) => (
              <LotRow key={lot.id} lot={lot} />
            ))}
          </ul>
        )}
      </section>

      <section className='rounded-content-md border border-border p-4'>
        <h3 className='mb-3 text-sm font-semibold'>
          {t('studio.container.credits.activityTitle')}
        </h3>
        {ledgerRows.length === 0 ? (
          <p className='text-sm text-muted-foreground'>
            {t('studio.container.credits.activityEmpty')}
          </p>
        ) : (
          <div ref={scrollerRef}>
            <ScrollArea scrollbars='vertical' viewportClassName='max-h-80'>
              <table className='w-full text-left text-sm'>
                <thead className='text-xs text-muted-foreground'>
                  <tr>
                    <th className='sticky top-0 bg-background py-1 font-medium'>
                      {t('studio.container.credits.colTime')}
                    </th>
                    <th className='sticky top-0 bg-background py-1 font-medium'>
                      {t('studio.container.credits.colWho')}
                    </th>
                    <th className='sticky top-0 bg-background py-1 font-medium'>
                      {t('studio.container.credits.colProject')}
                    </th>
                    <th className='sticky top-0 bg-background py-1 font-medium'>
                      {t('studio.container.credits.colModel')}
                    </th>
                    <th className='sticky top-0 bg-background py-1 text-right font-medium'>
                      {t('studio.container.credits.colAmount')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerRows.map((entry) => (
                    <LedgerRow key={entry.id} entry={entry} />
                  ))}
                </tbody>
              </table>
              <div ref={sentinelRef} aria-hidden='true' />
              <div className='flex items-center justify-center py-2 text-2xs tracking-wider text-muted-foreground'>
                {isFetchingNextPage ? (
                  <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden='true' />
                ) : !hasNextPage ? (
                  <span data-testid='studio-ledger-end'>
                    · {t('studio.container.credits.activityEnd')} ·
                  </span>
                ) : null}
              </div>
            </ScrollArea>
          </div>
        )}
      </section>
    </div>
  );
}
