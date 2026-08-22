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
  type StudioPurchaseView,
} from '@web/data/api/credits';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
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
 * One top-up this studio received.
 * @param props - The purchase.
 * @param props.lot - Who bought it, when, and what is left of it.
 * @returns The row.
 */
const LotRow = React.memo(function LotRow({
  lot,
}: {
  lot: StudioPurchaseView;
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
          {formatDate(lot.createdAt)}
        </span>
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
 * One line of the purchase block that is not a purchase: what is owed, and
 * the total the block adds up to.
 * @param props - The line.
 * @param props.testId - What a test reaches it by.
 * @param props.label - What this line is.
 * @param props.amount - Its figure.
 * @param props.strong - Whether it is the total, which is set apart by a rule.
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
        strong && 'font-semibold',
      )}
    >
      <span className='text-sm'>{label}</span>
      <span className='ml-auto text-right text-sm tabular-nums'>
        {formatAmount(amount)}
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
  const note =
    entry.kind !== 'generation' || entry.charged === entry.consumed
      ? null
      : entry.owed !== 0 && entry.charged !== 0
        ? t('studio.container.credits.noteShortfall', {
          consumed: formatAmount(-entry.consumed),
          owed: formatAmount(-entry.owed),
        })
        : t('studio.container.credits.noteUnbilled', {
          consumed: formatAmount(-entry.consumed),
        });
  return (
    <tr data-testid={`studio-ledger-${entry.id}`} className='border-t border-border'>
      <td className='py-1.5 text-muted-foreground'>{formatDate(entry.createdAt)}</td>
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
        {formatAmount(entry.charged)}
        {note === null ? null : (
          <span
            data-testid='studio-ledger-note'
            className='ml-1.5 whitespace-nowrap rounded-content-sm bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground'
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
            {formatAmount(head.spendable ?? 0)}
            <small className='ml-1 align-baseline text-sm font-medium text-muted-foreground'>
              {t('studio.container.credits.unit')}
            </small>
          </p>
          <p className='mt-[3px] text-xs text-muted-foreground'>
            {t(`studio.container.credits.${state}Hint`)}
          </p>
        </div>
      </div>

      {state === 'spendable' || !isMember ? null : (
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
        {(head.lots ?? []).length === 0 ? (
          <p className='text-sm text-muted-foreground'>
            {t('studio.container.credits.lotsEmpty')}
          </p>
        ) : (
          <ul className='flex flex-col [&>li:first-child]:border-t-0 [&>li:first-child]:pt-0'>
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
