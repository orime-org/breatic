// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { creditSourceText } from '@web/features/credits/credit-source-label';

import { parseCreditDecimal } from '@breatic/shared';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { refundRefusal } from '@breatic/shared';
import type { CreditLotView, RefundRefusal } from '@breatic/shared';

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
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import {
  fetchCreditLots,
  requestCreditLotRefund,
} from '@web/data/api/credits';
import { SectionSkeleton } from '@web/components/SectionSkeleton';
import {
  ScrollCard,
  ListEnd,
  SellingOffNotice,
  Row,
  RowBalance,
  Rows,
  RuleLines,
  Section,
  SectionEmpty,
  SectionError,
  formatMoney,
} from '@web/features/credits/section-chrome';
import { creditLotsKey, invalidateAccountReads } from '@web/features/credits/account-reads';
import { useCreditsPaging } from '@web/features/credits/use-credits-paging';
import { useTranslation } from '@web/i18n/use-translation';

/** The translator, as the hook hands it over. */
type Translate = ReturnType<typeof useTranslation>;
import { formatLocalDay } from '@web/lib/format-day';
import { serverMessage } from '@web/data/api/server-message';
import { toast } from '@web/lib/toast';
import { usePaymentTiers } from '@web/features/credits/use-payment-tiers';

/**
 * The line under the balance, in the right column.
 *
 * The balance sits on the first line on every screen in this panel, so this
 * is where a row says why it carries no ask button. The state IS the reason:
 * the button appears exactly when the server would accept the ask, and this
 * word names what it would refuse with.
 * @param lot - The purchase.
 * @param refusal - Why it cannot be refunded, or null when it can.
 * @param t - The translator.
 * @returns The word, or null on a row that carries the button.
 */
function noteOf(
  lot: CreditLotView,
  refusal: RefundRefusal | null,
  t: Translate,
): string | null {
  if (refusal === null) return null;
  if (refusal === 'offline_contract') return t('credits.refundReason.offlineContract');
  if (refusal === 'already_asked') {
    return t(`credits.lifecycle.${lot.lifecycle}`);
  }
  if (refusal === 'already_spent') {
    // Spent to nothing and spent from read as different facts to the buyer,
    // though the rule refuses both on the same count.
    return parseCreditDecimal(lot.remainingCredits) === 0n
      ? t('credits.lifecycle.depleted')
      : t('credits.refundReason.spent');
  }
  if (refusal === 'restored') {
    // The buyer took the credits instead of the money after a refund failed.
    return t('credits.refundReason.restored');
  }
  if (refusal === 'window_closed') {
    return t('credits.refundReason.expired');
  }
  if (refusal === 'not_purchased') {
    // The row already names the source where a price would go, and the rule
    // at the foot of the screen states that only a purchase can be refunded.
    return null;
  }
  // Still pointed at a Studio. Which Studio is on the left now, so this says
  // the step that comes before asking.
  return t('credits.refundHint.assigned');
}

/** Whose purchases, and whether credits are charged and sold here. */
interface RefundsSectionProps {
  /** The signed-in account, for the query key. */
  userId: string | null;
  /** Whether this deployment records and deducts credits at all. */
  charging: boolean;
  /** Whether this deployment sells credits; the section exists only then. */
  selling: boolean;
}

/**
 * Account credit lots, newest first, with their current refund eligibility.
 *
 * A row's right column answers one question — can this be refunded. The ask
 * button when it can, the state when it cannot, and the state is the reason.
 * @param props - The account and whether credits are charged and sold here.
 * @param props.userId - The signed-in account, for the query key.
 * @param props.charging - Whether this deployment records and deducts credits at all.
 * @param props.selling - Whether this deployment sells credits.
 * @returns The section.
 */
export function RefundsSection({
  userId,
  charging,
  selling,
}: RefundsSectionProps): React.JSX.Element {
  const t = useTranslation();
  const read = React.useCallback(
    (cursor: string | undefined) =>
      fetchCreditLots(cursor === undefined ? undefined : { cursor }),
    [],
  );
  const paging = useCreditsPaging<CreditLotView>({
    queryKey: creditLotsKey(userId, 'all'),
    read,
    enabled: selling && userId !== null,
  });
  const terms = usePaymentTiers(selling);

  // One instant for the whole screen, so two rows cannot land on opposite
  // sides of a window closing between them. Held across renders as well, so
  // the rows it is handed to can be memoized: a fresh Date every render is a
  // prop that never compares equal.
  const now = React.useMemo(() => new Date(), []);

  return (
    <Section
      scrolls={false}
      title={t('credits.section.refunds')}
      // Online purchase terms have an independent read so their heading and
      // loading/error states remain available while account lots are read.
      footer={
        !selling ? undefined : (
          <div className='mt-3 flex flex-col gap-2'>
            <h3 className='text-sm font-semibold'>{t('credits.onlinePurchaseRefundTitle')}</h3>
            {terms.isSuccess ? (
              <RuleLines
                data-testid='refunds-terms'
                lines={terms.data.refundLines}
              />
            ) : terms.isError ? (
              <SectionError />
            ) : (
              <Skeleton className='h-12 w-full' />
            )}
          </div>
        )
      }
    >
      {!selling ? (
        <SellingOffNotice charging={charging} body={t('credits.notSoldHere.refundsBody')} />
      ) : paging.isPending ? (
        <SectionSkeleton />
      ) : paging.isError ? (
        <SectionError />
      ) : (
        <>
          {paging.rows.length === 0 ? (
            <SectionEmpty message={t('credits.refundsEmpty')} />
          ) : (
            <ScrollCard scrollerRef={paging.scrollerRef}>
              <Rows>
                {paging.rows.map((lot) => (
                  <LotRow key={lot.id} lot={lot} userId={userId} now={now} />
                ))}
              </Rows>
              <ListEnd paging={paging} />
            </ScrollCard>
          )}
        </>
      )}
    </Section>
  );
}

/** One purchase, whose account it is, and when the screen is judging it. */
interface LotRowProps {
  /** The purchase. */
  lot: CreditLotView;
  /** The signed-in account, for the keys an ask invalidates. */
  userId: string | null;
  /** The instant the window is judged against. */
  now: Date;
}

/**
 * One purchase, with the ask button or the reason there is none.
 *
 * The ask lives per row rather than on the section, so pressing one row's
 * button leaves the others pressable.
 *
 * It is confirmed before it is sent: the purchase then waits on a decision
 * made elsewhere, and there is nothing on this screen that takes it back.
 * @param props - The purchase, the account and the instant.
 * @param props.lot - The purchase.
 * @param props.userId - The signed-in account.
 * @param props.now - The instant the window is judged against.
 * @returns The row.
 */
const LotRow = React.memo(function LotRow({
  lot,
  userId,
  now,
}: LotRowProps): React.JSX.Element {
  const t = useTranslation();
  const client = useQueryClient();
  const [asking, setAsking] = React.useState(false);
  const refusal = refundRefusal(lot, now);
  const note = noteOf(lot, refusal, t);

  const askRefund = useMutation({
    mutationFn: () => requestCreditLotRefund(lot.id),
    onSuccess: async () => {
      // The purchase stays on this list and changes what it says, and it
      // stops counting towards what the account holds — which the overview
      // reports and the purchase history repeats.
      //
      // Awaited, which holds the mutation pending until the row the ask
      // changed is back. Settling first leaves the button live over a row
      // that still reads `active`, and a second press earns the server's
      // refusal for an ask that in fact went through.
      await invalidateAccountReads(client, userId);
    },
    onError: (err: unknown) => {
      // The server wrote a sentence for each of the four refusals and this is
      // the one moment the screen and the server disagree about the rule, so
      // its answer is the only true thing there is to say. A generic line is
      // honest only when the request never reached us, where the message axios
      // supplies is English written for a developer.
      toast.error(serverMessage(err, t('credits.refundFailed')));
      // The row offered an ask the server turned down, which means what this
      // screen holds is out of date — and so are the other two. The refusal
      // that matters here is the 409 saying the pack is already on its way
      // out: the three figures and the history row are behind by the same
      // beat this list is.
      void invalidateAccountReads(client, userId);
    },
  });

  return (
    <Row
      main={`${
        lot.paidCents === null
          ? creditSourceText(lot, t)
          : formatMoney(lot.paidCents, lot.currency ?? 'usd')
      } · ${formatLocalDay(lot.createdAt)}`}
      sub={
        lot.designatedStudioName === null
          ? t('credits.unassigned')
          : t('credits.assignedTo', { studio: lot.designatedStudioName })
      }
      right={
        <>
          <RowBalance data-testid='lot-remaining' credits={lot.remainingCredits} />
          {refusal === null ? (
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
                      loading={askRefund.isPending}
                      onClick={(event) => {
                        // Held open while the server answers: a refusal is
                        // read off the toast with the confirm still in reach,
                        // and only an ask that went through closes it.
                        event.preventDefault();
                        askRefund.mutate(undefined, {
                          onSuccess: () => {
                            setAsking(false);
                          },
                        });
                      }}
                    >
                      {t('credits.confirmRefund.confirm')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : (
          // Quiet text, no border and no fill. This column is where the ask
          // button sits, so anything drawn as a block here reads as a button
          // that has been turned off — and a state the purchase is in is not
          // a control at all.
            <span className='block text-xs text-muted-foreground'>{note}</span>
          )}
        </>
      }
    />
  );
});
