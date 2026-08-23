// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { Skeleton } from '@web/components/ui/skeleton';
import {
  fetchStudioCredits,
  type StudioLedgerView,
  type StudioLotView,
} from '@web/data/api/credits';
import { formatCreditAmount } from '@web/lib/format-credit-amount';
import { formatLocalDay } from '@web/lib/format-day';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { useScrolledToEnd } from '@web/lib/use-scrolled-to-end';

interface CreditsTabProps {
  /** The studio being viewed. */
  slug: string;
}

/**
 * One lot this studio holds right now.
 * @param props - The lot.
 * @param props.lot - Who bought it, when, and what is left of it.
 * @returns The row.
 */
const LotRow = React.memo(function LotRow({
  lot,
}: {
  lot: StudioLotView;
}): React.JSX.Element {
  const t = useTranslation();
  return (
    <li
      data-testid={`studio-lot-${lot.id}`}
      className='flex items-baseline gap-3 border-t border-border py-2.5 first:border-t-0 first:pt-0'
    >
      <span>
        <span className='block text-sm'>{lot.buyerName ?? '—'}</span>
        <span className='block text-xs text-muted-foreground'>
          {formatLocalDay(lot.createdAt)}
        </span>
      </span>
      <span className='ml-auto text-right tabular-nums'>
        <span className='block text-sm font-semibold'>
          {formatCreditAmount(lot.remainingCredits)}
        </span>
        <span className='block text-xs text-muted-foreground'>
          {t('studio.container.credits.lotPurchased', {
            amount: formatCreditAmount(lot.purchasedCredits),
          })}
        </span>
      </span>
    </li>
  );
});

/**
 * A line of the credits block that is not a lot: what is owed, and the
 * total the block adds up to.
 * @param props - The line.
 * @param props.testId - What a test reaches it by.
 * @param props.label - What this line is.
 * @param props.amount - Its figure.
 * @param props.strong - Whether it is the total, which is set apart by its weight.
 * @returns The row.
 */
const SummaryRow = React.memo(function SummaryRow({
  testId,
  label,
  amount,
  strong = false,
}: {
  testId: string;
  label: string;
  amount: number;
  strong?: boolean;
}): React.JSX.Element {
  return (
    <li
      data-testid={testId}
      className={cn(
        'flex items-baseline gap-3 border-t border-border py-2.5',
        // The total is set apart by its weight. Every rule in this interface
        // is one pixel.
        strong && 'font-bold',
      )}
    >
      <span className='text-sm'>{label}</span>
      <span
        className={cn(
          'ml-auto text-right text-sm tabular-nums',
          strong ? 'font-bold' : 'font-semibold',
        )}
      >
        {formatCreditAmount(amount)}
      </span>
    </li>
  );
});

/**
 * One event in this studio's ledger.
 *
 * The amount column is what left the pool. A run that used more than the pool
 * could cover says so underneath, in a line that appears only when the two
 * figures differ — no line means the run cost exactly what it was charged.
 *
 * A repayment merges the project and model columns and names itself there: it
 * happened in no project and used no model, so filling those cells would be
 * inventing values.
 * @param props - The entry.
 * @param props.entry - What happened.
 * @returns The table row.
 */
const LedgerRow = React.memo(function LedgerRow({
  entry,
}: {
  entry: StudioLedgerView;
}): React.JSX.Element {
  const t = useTranslation();
  // What separates the two sentences is whether the studio ended up owing,
  // which `owed` answers on its own. A charge that reached no lot at all is
  // still a shortfall — it is the whole bill turned into debt, and reading it
  // off `charged` would call the moment the debt was created a free run.
  const note =
    entry.kind !== 'generation' || entry.charged === entry.consumed
      ? null
      : entry.owed !== 0
        ? t('studio.container.credits.noteShortfall', {
          consumed: formatCreditAmount(-entry.consumed),
          owed: formatCreditAmount(-entry.owed),
        })
        : t('studio.container.credits.noteUnbilled', {
          consumed: formatCreditAmount(-entry.consumed),
        });
  return (
    <tr data-testid={`studio-ledger-${entry.id}`} className='border-t border-border'>
      <td className='py-1.5 text-muted-foreground'>{formatLocalDay(entry.createdAt)}</td>
      <td className='py-1.5'>{entry.actorName ?? '—'}</td>
      {entry.kind === 'debt_repayment' ? (
        <td
          data-testid='studio-ledger-event'
          colSpan={2}
          className='py-1.5 text-muted-foreground'
        >
          {t('studio.container.credits.eventRepayment')}
        </td>
      ) : (
        <>
          <td className='py-1.5 text-muted-foreground'>{entry.projectName ?? '—'}</td>
          <td className='py-1.5 text-muted-foreground'>{entry.model ?? '—'}</td>
        </>
      )}
      <td className='py-1.5 text-right tabular-nums'>
        {formatCreditAmount(entry.charged)}
        {note === null ? null : (
          <span
            data-testid='studio-ledger-note'
            className='block text-2xs font-normal text-muted-foreground'
          >
            {note}
          </span>
        )}
      </td>
    </tr>
  );
});

/**
 * The Credits tab — what this studio can spend, and where its credits went.
 *
 * The admin's page. The pool is the studio's and so is the ledger beside it:
 * everyone generating here spends the same credits, whoever paid for them, and
 * the person on each line is whoever ran the generation.
 *
 * Buying and refunding are account-level and live in the account's credit
 * overlay; this tab reports.
 * @param props - The studio being viewed.
 * @param props.slug - The studio being viewed.
 * @returns The Credits tab content.
 */
export function CreditsTab({ slug }: CreditsTabProps): React.JSX.Element {
  const t = useTranslation();

  const query = useInfiniteQuery({
    queryKey: ['studio-credits', slug],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      fetchStudioCredits(slug, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.ledger.nextCursor ?? undefined,
  });

  const { fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } =
    query;
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
    //
    // `isFetchNextPageError`, because a first page that arrived leaves the
    // query successful: `isError` describes the query as a whole and stays
    // false for exactly the failure this is here to notice.
    failed: isFetchNextPageError,
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
  // arrived leaves the balance, the lots and the rows already read in
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

  // Four situations, and each one gets its own sentence. Reading them off the
  // balance alone cannot tell "nothing was ever assigned here" from "it was
  // all spent" — both are zero, and only one of them is answered by assigning
  // more.
  const state =
    (head.debt ?? 0) > 0
      ? 'debt'
      : (head.spendable ?? 0) > 0
        ? 'spendable'
        : (head.lots ?? []).length > 0
          ? 'depleted'
          : 'none';

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
            {formatCreditAmount(head.spendable ?? 0)}
            <small className='ml-1 align-baseline text-sm font-medium text-muted-foreground'>
              {t('studio.container.credits.unit')}
            </small>
          </p>
          <p className='mt-[3px] text-xs text-muted-foreground'>
            {t(`studio.container.credits.${state}Hint`)}
          </p>
        </div>
      </div>

      {state === 'spendable' ? null : (
        <p
          data-testid='studio-credits-unassigned-notice'
          className='rounded-content-sm border border-status-warning-border bg-status-warning-bg px-3 py-2.5 text-sm'
        >
          {t(`studio.container.credits.${state}Prompt`)}
        </p>
      )}

      <section className='rounded-content-md border border-border p-4'>
        <h3 className='mb-3 text-sm font-semibold'>
          {t('studio.container.credits.lotsTitle')}
        </h3>
        {/* This block explains the figure above it, so what decides between a
            list and an empty state is whether there is anything to add up. A
            studio that owes without ever having been assigned a lot is the one
            reading most in need of the explanation: the balance is below zero
            and the only line that accounts for it is the debt. */}
        {(head.lots ?? []).length === 0 && (head.debt ?? 0) === 0 ? (
          <p className='text-sm text-muted-foreground'>
            {t('studio.container.credits.lotsEmpty')}
          </p>
        ) : (
          <ul className='flex flex-col [&>li:first-child]:border-t-0 [&>li:first-child]:pt-0 [&>li:last-child]:pb-0'>
            {(head.lots ?? []).map((lot) => (
              <LotRow key={lot.id} lot={lot} />
            ))}
            {(head.debt ?? 0) > 0 ? (
              <SummaryRow
                testId='studio-lots-debt'
                label={t('studio.container.credits.lotsDebt')}
                amount={-(head.debt ?? 0)}
              />
            ) : null}
            <SummaryRow
              testId='studio-lots-total'
              label={t('studio.container.credits.lotsTotal')}
              amount={head.spendable ?? 0}
              strong
            />
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
                ) : isFetchNextPageError ? (
                  <span role='status' data-testid='studio-ledger-page-error'>
                    {t('studio.container.credits.activityPageError')}
                  </span>
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
