// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import type { CreditLedgerView, CreditOverview } from '@breatic/shared';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select';
import { Badge } from '@web/components/ui/badge';
import { fetchCreditLedger } from '@web/data/api/credits';
import {
  Card,
  ListEnd,
  Section,
  Footnote,
  SectionEmpty,
  SectionError,
  SectionSkeleton,
  TableHead,
} from '@web/features/credits/section-chrome';
import { useCreditsPaging } from '@web/features/credits/use-credits-paging';
import { useTranslation } from '@web/i18n/use-translation';
import { formatCreditAmount } from '@web/lib/format-credit-amount';
import { formatLocalDay } from '@web/lib/format-day';

/** Whose spending, and which studios there are to narrow to. */
interface LedgerSectionProps {
  /** The signed-in account, for the query key. */
  userId: string | null;
  /** What the account holds, for the studio filter and the billing flag. */
  overview: CreditOverview;
}

/** The value the filter carries when it is not narrowing to anything. */
const ALL_STUDIOS = 'all';

/**
 * Every generation this account has paid for, one line each.
 *
 * One line per generation and not per ledger row: a generation draws on as
 * many purchases as it needs and writes a row for each, so listing the rows
 * would show the same run several times, each with a fragment of its cost.
 *
 * Spending is listed even where nothing was charged. A deployment with
 * billing off still records what was used, and that record is the answer to
 * "what have we been running".
 * @param props - The account and the overview.
 * @param props.userId - The signed-in account, for the query key.
 * @param props.overview - What the account holds, for the filter.
 * @returns The section.
 */
export function LedgerSection({
  userId,
  overview,
}: LedgerSectionProps): React.JSX.Element {
  const t = useTranslation();
  const [studioId, setStudioId] = React.useState<string>(ALL_STUDIOS);

  const read = React.useCallback(
    (cursor: string | undefined) =>
      fetchCreditLedger({
        ...(studioId === ALL_STUDIOS ? {} : { studioId }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    [studioId],
  );
  const paging = useCreditsPaging<CreditLedgerView>({
    queryKey: ['credits', 'ledger', userId, studioId],
    read,
    enabled: userId !== null,
  });

  // The labels are read outside the memo and the memo depends on their
  // values. `useTranslation` hands back a function whose identity never
  // changes — switching language re-renders without changing it — so a memo
  // keyed on the function itself keeps serving the previous language.
  const colDay = t('credits.colDay');
  const colWho = t('credits.colWho');
  const colStudio = t('credits.colStudio');
  const colProject = t('credits.colProject');
  const colModel = t('credits.colModel');
  const colAmount = t('credits.colAmount');
  const columns = React.useMemo(
    () =>
      [
        { key: 'day', label: colDay },
        { key: 'who', label: colWho },
        { key: 'studio', label: colStudio },
        { key: 'project', label: colProject },
        { key: 'model', label: colModel },
        { key: 'amount', label: colAmount, align: 'right' as const },
      ] as const,
    [colDay, colWho, colStudio, colProject, colModel, colAmount],
  );

  return (
    <Section title={t('credits.section.ledger')}>
      {overview.billing ? null : (
        <Footnote>{t('credits.ledgerBillingOff')}</Footnote>
      )}
      {/* The card stays put while a narrowed read is in flight: the control
          that started it lives inside, and replacing the whole block with a
          skeleton takes the focus with it. */}
      {paging.isError ? (
        <SectionError />
      ) : (
        <Card>
          <div className='mb-3 flex items-center gap-2.5'>
            <h3 className='text-sm font-semibold'>
              {t('credits.allSpending')}
            </h3>
            <div className='ml-auto'>
              <Select value={studioId} onValueChange={setStudioId}>
                <SelectTrigger
                  className='h-7 w-auto gap-2 text-sm'
                  aria-label={t('credits.filterByStudio')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_STUDIOS}>
                    {t('credits.allStudios')}
                  </SelectItem>
                  {overview.studios.map((studio) => (
                    <SelectItem key={studio.studioId} value={studio.studioId}>
                      {studio.studioName === ''
                        ? t('credits.deletedStudio')
                        : studio.studioName}
                      {studio.deleted ? ` · ${t('credits.deletedBadge')}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {paging.isPending ? (
            <SectionSkeleton />
          ) : paging.rows.length === 0 ? (
            <SectionEmpty message={t('credits.ledgerEmpty')} />
          ) : (
            <>
              <table className='w-full border-collapse text-left text-sm'>
                <TableHead columns={columns} />
                <tbody>
                  {paging.rows.map((row) => (
                    <LedgerRow key={row.id} row={row} />
                  ))}
                </tbody>
              </table>
              <ListEnd
                sentinelRef={paging.sentinelRef}
                loading={paging.isFetchingNextPage}
                more={paging.hasNextPage}
                failed={paging.pageFailed}
              />
            </>
          )}
        </Card>
      )}
    </Section>
  );
}

/** The generation to draw. */
interface LedgerRowProps {
  /** One generation's line. */
  row: CreditLedgerView;
}

/**
 * One time this account's money left a purchase: when, who, where, with what,
 * and how much.
 *
 * A run that outran the purchases used more than this. That part is the
 * studio's debt, which names no payer, and the studio's own page reports
 * it.
 * @param props - The generation.
 * @param props.row - One generation's line.
 * @returns The row.
 */
const LedgerRow = React.memo(function LedgerRow({ row }: LedgerRowProps): React.JSX.Element {
  const t = useTranslation();
  const repayment = row.kind === 'debt_repayment';

  return (
    <tr className='border-t border-border'>
      <td className='py-1.5 text-muted-foreground'>
        {formatLocalDay(row.createdAt)}
      </td>
      <td className='py-1.5'>{row.actorName ?? '—'}</td>
      <td className='py-1.5 text-muted-foreground'>
        {row.studioName ?? '—'}
      </td>
      {/* A repayment has no project and no model. Naming what it is fills
          those two columns with the answer rather than with a dash. */}
      {repayment ? (
        <td className='py-1.5 text-muted-foreground' colSpan={2}>
          {t('credits.eventRepayment')}
        </td>
      ) : (
        <>
          <td className='py-1.5 text-muted-foreground'>
            {row.projectName ?? '—'}
          </td>
          <td className='py-1.5 text-muted-foreground'>{row.model ?? '—'}</td>
        </>
      )}
      {/* On most lines the figure is what left this account's purchases. On
          a line that drew on none it is what the run would have cost and
          nothing moved, which the number alone cannot say — so that line
          carries the word. */}
      <td className='py-1.5 text-right tabular-nums'>
        {row.kind === 'unbilled' ? (
          <Badge variant='secondary' className='mr-2 align-middle'>
            {t('credits.eventUnbilled')}
          </Badge>
        ) : null}
        {formatCreditAmount(row.amount)}
      </td>
    </tr>
  );
});
