// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import type { CreditLotView } from '@breatic/shared';

import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
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
import { ListEnd } from '@web/features/credits/sections/LotsSection';
import { useCreditsPaging } from '@web/features/credits/use-credits-paging';
import { useTranslation } from '@web/i18n/use-translation';
import { formatCreditAmount } from '@web/lib/format-credit-amount';
import { formatLocalDay } from '@web/lib/format-day';
import { toast } from '@web/lib/toast';

/** Whose purchases, and whether billing is on at all. */
interface RefundsSectionProps {
  /** The signed-in account, for the query key. */
  userId: string | null;
  /** Whether this deployment charges for generation at all. */
  billing: boolean;
}

/**
 * What can be refunded, and what has been asked for already.
 *
 * Two lists rather than one. What a reader can act on and what they are
 * waiting on are different questions, and a refused request stays visible
 * because the lifecycle keeps no trace of it — only a count of attempts.
 *
 * Asking is not open yet, so the button is dimmed and says why when pressed
 * rather than being `disabled`: a control nobody can press is also a control
 * nobody can ask about.
 * @param props - The account and whether billing is on.
 * @param props.userId - The signed-in account, for the query key.
 * @param props.billing - Whether this deployment charges at all.
 * @returns The section.
 */
export function RefundsSection({
  userId,
  billing,
}: RefundsSectionProps): React.JSX.Element {
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

  const refundable = paging.rows.filter(
    (lot) => lot.lifecycle === 'active' && lot.remainingCredits > 0,
  );
  const asked = paging.rows.filter(
    (lot) =>
      lot.lifecycle === 'refund_pending' ||
      lot.lifecycle === 'refunding' ||
      lot.lifecycle === 'refunded' ||
      lot.refundAttempts > 0,
  );

  /** Say why the button did nothing. */
  const explain = (): void => {
    toast.warning(t('credits.refundNotOpen'));
  };

  return (
    <Section title={t('credits.section.refunds')}>
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
      ) : refundable.length === 0 && asked.length === 0 ? (
        <SectionEmpty message={t('credits.refundsEmpty')} />
      ) : (
        <>
          {refundable.length === 0 ? null : (
            <Card title={t('credits.refundable')}>
              <Rows>
                {refundable.map((lot) => (
                  <Row
                    key={lot.id}
                    main={`${formatMoney(lot.paidCents, lot.currency)} · ${formatLocalDay(lot.createdAt)}`}
                    sub={t('credits.refundableHint', {
                      credits: formatCreditAmount(lot.remainingCredits),
                      money: formatMoney(lot.remainingCredits, lot.currency),
                    })}
                    right={
                      <Button
                        type='button'
                        variant='outline'
                        size='sm'
                        aria-disabled='true'
                        className='opacity-50 hover:bg-transparent'
                        onClick={explain}
                      >
                        {t('credits.askRefund')}
                      </Button>
                    }
                  />
                ))}
              </Rows>
            </Card>
          )}
          {asked.length === 0 ? null : (
            <Card title={t('credits.refundsAsked')}>
              <Rows>
                {asked.map((lot) => (
                  <Row
                    key={lot.id}
                    main={
                      <>
                        {formatMoney(lot.paidCents, lot.currency)} ·{' '}
                        {formatLocalDay(lot.createdAt)}
                        <Badge
                          variant={
                            lot.lifecycle === 'active'
                              ? 'destructive'
                              : 'secondary'
                          }
                          className='ml-2 align-middle'
                        >
                          {lot.lifecycle === 'active'
                            ? t('credits.refundRefused')
                            : t(`credits.lifecycle.${lot.lifecycle}`)}
                        </Badge>
                      </>
                    }
                    sub={
                      lot.lifecycle === 'active'
                        ? t('credits.refundRefusedHint')
                        : t('credits.refundPendingHint', {
                          credits: formatCreditAmount(lot.remainingCredits),
                        })
                    }
                  />
                ))}
              </Rows>
            </Card>
          )}
          <ListEnd
            sentinelRef={paging.sentinelRef}
            loading={paging.isFetchingNextPage}
            more={paging.hasNextPage}
          />
          <SectionEmpty message={t('credits.refundsNote')} />
        </>
      )}
    </Section>
  );
}
