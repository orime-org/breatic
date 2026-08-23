// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import type { CreditLotView } from '@breatic/shared';

import { Badge } from '@web/components/ui/badge';
import { fetchCreditLots } from '@web/data/api/credits';
import {
  Card,
  Notice,
  Row,
  Rows,
  Section,
  SectionEmpty,
  SectionError,
  SectionSkeleton,
  formatMoney,
} from '@web/features/credits/section-chrome';
import { useCreditsPaging } from '@web/features/credits/use-credits-paging';
import { useTranslation } from '@web/i18n/use-translation';
import { formatCreditAmount } from '@web/lib/format-credit-amount';
import { formatLocalDay } from '@web/lib/format-day';

/** Whose purchases, and whether billing is on at all. */
interface LotsSectionProps {
  /** The signed-in account, for the query key. */
  userId: string | null;
  /** Whether this deployment charges for generation at all. */
  billing: boolean;
}

/**
 * Every purchase this account has made, newest first.
 *
 * What was paid leads the row rather than the credits bought: this is the
 * record somebody checks against a card statement, and the amount charged is
 * what appears there.
 * @param props - The account and whether billing is on.
 * @param props.userId - The signed-in account, for the query key.
 * @param props.billing - Whether this deployment charges at all.
 * @returns The section.
 */
export function LotsSection({
  userId,
  billing,
}: LotsSectionProps): React.JSX.Element {
  const t = useTranslation();
  const read = React.useCallback(
    (cursor: string | undefined) =>
      fetchCreditLots(cursor === undefined ? undefined : { cursor }),
    [],
  );
  const paging = useCreditsPaging<CreditLotView>({
    queryKey: ['credits', 'lots', userId, 'all'],
    read,
    enabled: billing && userId !== null,
  });

  const unassigned = paging.rows.filter(
    (lot) => lot.lifecycle === 'active' && lot.designatedStudioId === null,
  ).length;

  return (
    <Section title={t('credits.section.lots')}>
      {!billing ? (
        <Notice
          title={t('credits.billingOff.title')}
          body={t('credits.billingOff.body')}
          tone='info'
        />
      ) : paging.isPending ? (
        <SectionSkeleton />
      ) : paging.isError ? (
        <SectionError />
      ) : paging.rows.length === 0 ? (
        <>
          <SectionEmpty message={t('credits.lotsEmpty')} />
          <Notice
            title={t('credits.lotsEmptyNotice.title')}
            body={t('credits.lotsEmptyNotice.body')}
          />
        </>
      ) : (
        <>
          <Card>
            <Rows>
              {paging.rows.map((lot) => (
                <LotRow key={lot.id} lot={lot} />
              ))}
            </Rows>
          </Card>
          <ListEnd
            sentinelRef={paging.sentinelRef}
            loading={paging.isFetchingNextPage}
            more={paging.hasNextPage}
          />
          {unassigned === 0 ? null : (
            <Notice
              title={t('credits.unassignedNotice.title', { count: unassigned })}
              body={t('credits.unassignedNotice.body')}
            />
          )}
        </>
      )}
    </Section>
  );
}

/** The purchase to draw. */
interface LotRowProps {
  /** The purchase. */
  lot: CreditLotView;
}

/**
 * One purchase: what it cost, when, where it points, and what is left of it.
 * @param props - The purchase.
 * @param props.lot - The purchase.
 * @returns The row.
 */
function LotRow({ lot }: LotRowProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <Row
      main={
        <>
          {formatMoney(lot.paidCents, lot.currency)} · {formatLocalDay(lot.createdAt)}
          <LotBadge lifecycle={lot.lifecycle} />
        </>
      }
      sub={
        lot.designatedStudioName === null
          ? t('credits.unassigned')
          : t('credits.assignedTo', { studio: lot.designatedStudioName })
      }
      right={
        <>
          <span className='block text-sm font-semibold'>
            {formatCreditAmount(lot.remainingCredits)}
          </span>
          <span className='block text-xs text-muted-foreground'>
            {t('credits.ofPurchased', {
              amount: formatCreditAmount(lot.purchasedCredits),
            })}
          </span>
        </>
      }
    />
  );
}

/** The lifecycle to name. */
interface LotBadgeProps {
  /** The purchase's lifecycle. */
  lifecycle: string;
}

/**
 * What state a purchase is in, when that is worth saying.
 *
 * An active purchase with credits left carries no badge: that is the ordinary
 * case, and a badge on every row says nothing.
 * @param props - The lifecycle.
 * @param props.lifecycle - The purchase's lifecycle.
 * @returns The badge, or nothing.
 */
export function LotBadge({ lifecycle }: LotBadgeProps): React.JSX.Element | null {
  const t = useTranslation();
  if (lifecycle === 'active') return null;
  return (
    <Badge
      variant={lifecycle === 'refunded' ? 'destructive' : 'secondary'}
      className='ml-2 align-middle'
    >
      {t(`credits.lifecycle.${lifecycle}`)}
    </Badge>
  );
}

/** Where a list ends, and whether more is coming. */
interface ListEndProps {
  /** Goes on the empty element after the last row. */
  sentinelRef: (node: HTMLElement | null) => void;
  /** A further page is on its way. */
  loading: boolean;
  /** There are more pages to read. */
  more: boolean;
}

/**
 * The foot of a paging list: the sentinel that asks for the next page, and
 * what the list is doing.
 * @param props - The sentinel and the two states.
 * @param props.sentinelRef - Goes on the empty element after the last row.
 * @param props.loading - A further page is on its way.
 * @param props.more - There are more pages to read.
 * @returns The foot.
 */
export function ListEnd({
  sentinelRef,
  loading,
  more,
}: ListEndProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className='flex items-center justify-center py-2 text-2xs tracking-widest text-muted-foreground'>
      <span ref={sentinelRef} aria-hidden='true' />
      {loading ? (
        <Loader2 className='h-4 w-4 animate-spin' aria-hidden='true' />
      ) : more ? null : (
        t('credits.listEnd')
      )}
    </div>
  );
}
