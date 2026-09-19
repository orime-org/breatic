// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { refundRefusal } from '@breatic/shared';
import type { CreditLotView } from '@breatic/shared';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@web/components/ui/alert-dialog';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import {
  fetchCreditLots,
  requestCreditLotRefund,
} from '@web/data/api/credits';
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
} from '@web/features/credits/section-chrome';
import { useCreditsPaging } from '@web/features/credits/use-credits-paging';
import { useTranslation } from '@web/i18n/use-translation';
import { formatCreditAmount } from '@web/lib/format-credit-amount';
import { formatLocalDay } from '@web/lib/format-day';
import { toast } from '@web/lib/toast';

/**
 * What each lifecycle in the under-refund list says about itself.
 *
 * Two entries because the list holds two lifecycles. `credits.lifecycle`
 * beside them still names all five, which is what the badge reads.
 */
const UNDER_REFUND_HINT = {
  refund_pending: 'credits.refundPendingHint',
  refunding: 'credits.refundingHint',
} as const;

/**
 * Which sentence an under-refund row carries.
 *
 * The list holds two lifecycles and the badge names each one, so the sentence
 * beside it has to be about that same one. Both end at the same place — the
 * purchase cannot be pointed at a studio — and what differs is only which of
 * them the row is in.
 * @param lifecycle - The purchase's lifecycle.
 * @returns The translation key for that lifecycle.
 */
function underRefundHintKey(lifecycle: string): string {
  return (
    UNDER_REFUND_HINT[lifecycle as keyof typeof UNDER_REFUND_HINT] ??
    UNDER_REFUND_HINT.refund_pending
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
 * What can be refunded, and what is under refund right now.
 *
 * The screen shows what a purchase is, not what it has been through. Two
 * lists: what a reader can act on, and what is under refund right now. A
 * purchase that was turned down is an ordinary spendable purchase again, so
 * it goes back to the first list carrying no trace of having been asked
 * about; a refunded one is no longer theirs and appears in neither.
 *
 * The conditions live in the first list's membership test, and the terms
 * below state them. A rule gets stated, not built into a control that points
 * at another screen.
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

  // The card below calls these refundable, so the membership test is the rule
  // itself — the same function the server answers the ask with. A purchase
  // listed here that the server would turn down is a promise this screen
  // cannot keep, and one the server would allow that never appears here is a
  // right the buyer cannot reach.
  const now = new Date();
  const refundable = paging.rows.filter(
    (lot) => refundRefusal(lot, now) === null,
  );
  // What this list answers is why these cannot be spent or assigned right
  // now. A refunded purchase is no longer the buyer's — the money is back
  // with them — and one that came back to `active` is an ordinary spendable
  // purchase again, so neither belongs here.
  const underRefund = paging.rows.filter(
    (lot) =>
      lot.lifecycle === 'refund_pending' || lot.lifecycle === 'refunding',
  );

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
      ) : refundable.length === 0 && underRefund.length === 0 ? (
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
                  <RefundRow key={lot.id} lot={lot} userId={userId} />
                ))}
              </Rows>
            </Card>
          )}
          {underRefund.length === 0 ? null : (
            <Card title={t('credits.refundsAsked')}>
              <Rows>
                {underRefund.map((lot) => (
                  <Row
                    key={lot.id}
                    main={
                      <>
                        {formatMoney(lot.paidCents, lot.currency)} ·{' '}
                        {formatLocalDay(lot.createdAt)}
                        <Badge variant='secondary' className='ml-2 align-middle'>
                          {t(`credits.lifecycle.${lot.lifecycle}`)}
                        </Badge>
                      </>
                    }
                    sub={t(underRefundHintKey(lot.lifecycle), {
                      credits: formatCreditAmount(lot.remainingCredits),
                    })}
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
          <Footnote>
            {t('credits.refundsNote')} {t('credits.refundsNoteUnassigned')}
          </Footnote>
        </>
      )}
    </Section>
  );
}

/** One purchase that can be asked about, and whose account it is. */
interface RefundRowProps {
  /** The purchase. */
  lot: CreditLotView;
  /** The signed-in account, for the keys the ask invalidates. */
  userId: string | null;
}

/**
 * One refundable purchase, with the control that asks about it.
 *
 * The ask lives per row rather than on the section, so pressing one row's
 * button leaves the others pressable.
 *
 * It is confirmed before it is sent: the purchase then waits on a decision
 * made elsewhere, and there is nothing on this screen that takes it back.
 * @param props - The purchase and the account.
 * @param props.lot - The purchase.
 * @param props.userId - The signed-in account.
 * @returns The row.
 */
function RefundRow({ lot, userId }: RefundRowProps): React.JSX.Element {
  const t = useTranslation();
  const client = useQueryClient();
  const [asking, setAsking] = React.useState(false);

  const askRefund = useMutation({
    mutationFn: () => requestCreditLotRefund(lot.id),
    onSuccess: () => {
      // The purchase leaves this list for the one below it, and it stops
      // counting towards what the account holds — which the overview reports
      // and the purchase history repeats.
      void client.invalidateQueries({ queryKey: ['credits', 'lots', userId] });
      void client.invalidateQueries({
        queryKey: ['credits', 'overview', userId],
      });
      void client.invalidateQueries({
        queryKey: ['payment', 'history', userId],
      });
    },
    onError: () => {
      toast.error(t('credits.refundFailed'));
    },
  });

  return (
    <Row
      main={`${formatMoney(lot.paidCents, lot.currency)} · ${formatLocalDay(lot.createdAt)}`}
      sub={t('credits.refundableHint', {
        credits: formatCreditAmount(lot.remainingCredits),
      })}
      right={
        <>
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={askRefund.isPending}
            onClick={() => {
              setAsking(true);
            }}
          >
            {t('credits.askRefund')}
          </Button>
          <AlertDialog open={asking} onOpenChange={setAsking}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t('credits.confirmRefund.title')}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t('credits.confirmRefund.body')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  {t('credits.confirmRefund.cancel')}
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    askRefund.mutate();
                  }}
                >
                  {t('credits.confirmRefund.confirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      }
    />
  );
}
