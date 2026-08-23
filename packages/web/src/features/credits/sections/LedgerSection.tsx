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
import { fetchCreditLedger } from '@web/data/api/credits';
import {
  Card,
  Section,
  SectionEmpty,
  SectionError,
  SectionSkeleton,
  TableHead,
} from '@web/features/credits/section-chrome';
import { ListEnd } from '@web/features/credits/sections/LotsSection';
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

  const columns = React.useMemo(
    () =>
      [
        { key: 'day', label: t('credits.colDay') },
        { key: 'who', label: t('credits.colWho') },
        { key: 'studio', label: t('credits.colStudio') },
        { key: 'project', label: t('credits.colProject') },
        { key: 'model', label: t('credits.colModel') },
        { key: 'amount', label: t('credits.colAmount'), align: 'right' as const },
      ] as const,
    [t],
  );

  return (
    <Section title={t('credits.section.ledger')}>
      {overview.billing ? null : (
        <SectionEmpty message={t('credits.ledgerBillingOff')} />
      )}
      {paging.isPending ? (
        <SectionSkeleton />
      ) : paging.isError ? (
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
                      {studio.deleted
                        ? t('credits.deletedStudio')
                        : studio.studioName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {paging.rows.length === 0 ? (
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
 * One generation: when, who, where, with what, and what it cost.
 *
 * The amount column reports what actually left a purchase. When a studio ran
 * out mid-generation the run still used more than that, and the difference is
 * named underneath rather than folded into the figure — the two are different
 * amounts and the reader is owed both.
 * @param props - The generation.
 * @param props.row - One generation's line.
 * @returns The row.
 */
function LedgerRow({ row }: LedgerRowProps): React.JSX.Element {
  const t = useTranslation();
  const shortfall = row.owed !== 0;
  const unbilled = row.charged === 0 && row.owed === 0 && row.consumed !== 0;

  return (
    <tr className='border-t border-border'>
      <td className='py-1.5 text-muted-foreground'>
        {formatLocalDay(row.createdAt)}
      </td>
      <td className='py-1.5'>{row.actorName ?? '—'}</td>
      <td className='py-1.5 text-muted-foreground'>
        {row.studioName ?? t('credits.deletedStudio')}
      </td>
      <td className='py-1.5 text-muted-foreground'>
        {row.projectName ?? '—'}
      </td>
      <td className='py-1.5 text-muted-foreground'>{row.model ?? '—'}</td>
      <td className='py-1.5 text-right tabular-nums'>
        {formatCreditAmount(row.charged)}
        {shortfall ? (
          <span className='block text-2xs font-normal text-muted-foreground'>
            {t('credits.noteShortfall', {
              consumed: formatCreditAmount(Math.abs(row.consumed)),
              owed: formatCreditAmount(Math.abs(row.owed)),
            })}
          </span>
        ) : unbilled ? (
          <span className='block text-2xs font-normal text-muted-foreground'>
            {t('credits.noteUnbilled', {
              consumed: formatCreditAmount(Math.abs(row.consumed)),
            })}
          </span>
        ) : null}
      </td>
    </tr>
  );
}
