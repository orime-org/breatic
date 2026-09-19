// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

/** What a row puts in its right column and on the line under the amount. */
interface RowFace {
  /** The badge's text, or null on a row that carries the ask button. */
  badge: string | null;
  /**
   * Whether the badge names a step in the refund flow.
   *
   * Those steps end on their own — a decision is coming. The other badges say
   * the purchase cannot be refunded at all, and the two read differently so a
   * buyer can tell "wait for it" from "nothing to wait for".
   */
  inFlow: boolean;
  /** The line under the amount. */
  hint: string;
}

/**
 * What one purchase says about itself on this screen.
 *
 * The refusal decides everything here, which is what keeps the screen and the
 * server saying the same thing: the button appears exactly when the server
 * would accept the ask, and the badge names the same reason it would refuse
 * with.
 * @param lot - The purchase.
 * @param refusal - Why it cannot be refunded, or null when it can.
 * @param t - The translator.
 * @returns What to draw.
 */
function faceOf(
  lot: CreditLotView,
  refusal: RefundRefusal | null,
  t: (key: string, values?: Record<string, string | number>) => string,
): RowFace {
  const left = { credits: formatCreditAmount(lot.remainingCredits) };
  const remaining = t('credits.remaining', { amount: left.credits });
  if (refusal === null) {
    return { badge: null, inFlow: false, hint: remaining };
  }
  if (refusal === 'already_asked') {
    return {
      badge: t(`credits.lifecycle.${lot.lifecycle}`),
      inFlow: true,
      hint:
        lot.lifecycle === 'refunded'
          ? t('credits.refundHint.refunded')
          : t(
            lot.lifecycle === 'refunding'
              ? 'credits.refundingHint'
              : 'credits.refundPendingHint',
            left,
          ),
    };
  }
  if (refusal === 'already_spent') {
    // Spent to nothing and spent from read as different facts to the buyer,
    // though the rule refuses both on the same count. One still shows a
    // balance, so saying "used" beside a count of what is left would look
    // like a mistake.
    return lot.remainingCredits === 0
      ? {
        badge: t('credits.lifecycle.depleted'),
        inFlow: false,
        hint: t('credits.refundHint.depleted', {
          credits: formatCreditAmount(lot.purchasedCredits),
        }),
      }
      : {
        badge: t('credits.refundReason.spent'),
        inFlow: false,
        hint: remaining,
      };
  }
  if (refusal === 'window_closed') {
    return {
      badge: t('credits.refundReason.expired'),
      inFlow: false,
      hint: remaining,
    };
  }
  return {
    badge: t('credits.assignedTo', { studio: lot.designatedStudioName ?? '' }),
    inFlow: false,
    hint: t('credits.refundHint.assigned', left),
  };
}

/** Whose purchases, and whether billing is on at all. */
interface RefundsSectionProps {
  /** The signed-in account, for the query key. */
  userId: string | null;
  /** Whether this deployment charges for generation at all. */
  billing: boolean;
}

/**
 * Every pack this account ever bought, and where each one stands.
 *
 * One list in purchase order, newest first, holding the spent ones and the
 * already refunded ones too. A pack the buyer cannot find here is a pack he
 * has to guess about: the terms at the foot state the rule, and guessing
 * which of his purchases meets it is work this screen should be doing.
 *
 * A row's right column answers one question — can this be refunded. The ask
 * button when it can, the state when it cannot, and the state is the reason.
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

  // One instant for the whole render, so two rows on the same screen cannot
  // land on opposite sides of a window closing between them.
  const now = new Date();

  return (
    <Section
      title={t('credits.section.refunds')}
      // The terms hold whatever the list is doing, so they stay on screen for
      // a reader whose list is empty or still arriving.
      footer={
        billing ? <Footnote>{t('credits.refundsNote')}</Footnote> : undefined
      }
    >
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
          <SectionEmpty message={t('credits.refundsEmpty')} />
          <ListEnd
            sentinelRef={paging.sentinelRef}
            loading={paging.isFetchingNextPage}
            more={paging.hasNextPage}
            failed={paging.pageFailed}
          />
        </>
      ) : (
        <>
          <Card>
            <Rows>
              {paging.rows.map((lot) => (
                <LotRow key={lot.id} lot={lot} userId={userId} now={now} />
              ))}
            </Rows>
          </Card>
          <ListEnd
            sentinelRef={paging.sentinelRef}
            loading={paging.isFetchingNextPage}
            more={paging.hasNextPage}
            failed={paging.pageFailed}
          />
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
function LotRow({ lot, userId, now }: LotRowProps): React.JSX.Element {
  const t = useTranslation();
  const client = useQueryClient();
  const [asking, setAsking] = React.useState(false);
  const face = faceOf(lot, refundRefusal(lot, now), t);

  const askRefund = useMutation({
    mutationFn: () => requestCreditLotRefund(lot.id),
    onSuccess: () => {
      // The purchase stays on this list and changes what it says, and it
      // stops counting towards what the account holds — which the overview
      // reports and the purchase history repeats.
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
      sub={face.hint}
      right={
        face.badge === null ? (
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
        ) : face.inFlow ? (
          <Badge variant='secondary'>{face.badge}</Badge>
        ) : (
          // Quiet text, no border and no fill. This column is where the ask
          // button sits, so anything drawn as a block here reads as a button
          // that has been turned off — and a reason the purchase cannot be
          // refunded is not a control at all.
          <span className='text-xs text-muted-foreground'>{face.badge}</span>
        )
      }
    />
  );
}
