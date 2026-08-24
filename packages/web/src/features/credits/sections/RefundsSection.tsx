// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import type { CreditLotView } from '@breatic/shared';

import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { fetchCreditLots } from '@web/data/api/credits';
import {
  Card,
  ListEnd,
  Notice,
  Row,
  Rows,
  Section,
  Footnote,
  SectionEmpty,
  SectionError,
  SectionSkeleton,
  formatMoney,
  formatRefundable,
} from '@web/features/credits/section-chrome';
import { useCreditsPaging } from '@web/features/credits/use-credits-paging';
import { useTranslation } from '@web/i18n/use-translation';
import { formatCreditAmount } from '@web/lib/format-credit-amount';
import { formatLocalDay } from '@web/lib/format-day';
import { toast } from '@web/lib/toast';

/**
 * Whether a purchase has had a refund turned down.
 *
 * The count of attempts is what says so — the lifecycle went back to
 * spendable and keeps no trace of the request.
 * @param lot - The purchase.
 * @returns Whether a request on it was refused.
 */
function refused(lot: CreditLotView): boolean {
  return lot.refundAttempts > 0 && lot.lifecycle === 'active';
}

/** What each lifecycle in the submitted list says about itself. */
const SUBMITTED_HINT = {
  refund_pending: 'credits.refundPendingHint',
  refunding: 'credits.refundingHint',
  refunded: 'credits.refundedHint',
} as const;

/**
 * Which sentence a submitted row carries.
 *
 * The list holds three lifecycles and the badge names each one, so the
 * sentence beside it has to be about that same one. All three end at the same
 * place — the purchase cannot be pointed at a studio — and `designateLot`
 * refuses all three, so what differs is only which of them the row is in.
 * @param lifecycle - The purchase's lifecycle.
 * @returns The translation key for that lifecycle.
 */
function submittedHintKey(lifecycle: string): string {
  return (
    SUBMITTED_HINT[lifecycle as keyof typeof SUBMITTED_HINT] ??
    SUBMITTED_HINT.refund_pending
  );
}

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
        <>
          <SectionEmpty message={t('credits.refundsEmpty')} />
          {/* The sentinel goes here too. This section narrows the page after
              the server cut it, so a page whose purchases are all spent shows
              nothing while the cursor says there is more — and with nothing
              to observe, the next page is never asked for. */}
          <ListEnd
            sentinelRef={paging.sentinelRef}
            loading={paging.isFetchingNextPage}
            more={paging.hasNextPage}
            failed={paging.pageFailed}
          />
        </>
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
                      money: formatRefundable(lot.remainingCredits, lot.currency),
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
                        {/* What says a request was refused is the count of
                            attempts, which is also what put this row in the
                            list. The lifecycle says whether it is spendable. */}
                        <Badge
                          variant={refused(lot) ? 'destructive' : 'secondary'}
                          className='ml-2 align-middle'
                        >
                          {refused(lot)
                            ? t('credits.refundRefused')
                            : t(`credits.lifecycle.${lot.lifecycle}`)}
                        </Badge>
                      </>
                    }
                    sub={
                      refused(lot)
                        ? t('credits.refundRefusedHint')
                        : t(submittedHintKey(lot.lifecycle), {
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
            failed={paging.pageFailed}
          />
          <Footnote>{t('credits.refundsNote')}</Footnote>
        </>
      )}
    </Section>
  );
}
