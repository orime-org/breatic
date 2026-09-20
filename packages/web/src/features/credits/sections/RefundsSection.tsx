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
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
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
  RuleLines,
  Section,
  SectionEmpty,
  SectionError,
  SectionSkeleton,
  formatMoney,
} from '@web/features/credits/section-chrome';
import { useCreditsPaging } from '@web/features/credits/use-credits-paging';
import { useTranslation } from '@web/i18n/use-translation';

/** The translator, as the hook hands it over. */
type Translate = ReturnType<typeof useTranslation>;
import { formatCreditAmount } from '@web/lib/format-credit-amount';
import { formatLocalDay } from '@web/lib/format-day';
import { serverMessage } from '@web/data/api/server-message';
import { toast } from '@web/lib/toast';
import { usePaymentTiers } from '@web/features/credits/use-payment-tiers';

/** What a row puts in its right column and on the line under the amount. */
interface RowFace {
  /** The state's name, or null on a row that carries the ask button. */
  badge: string | null;
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
  t: Translate,
): RowFace {
  const left = { credits: formatCreditAmount(lot.remainingCredits) };
  const remaining = t('credits.remaining', { amount: left.credits });
  if (refusal === null) {
    return { badge: null, hint: remaining };
  }
  if (refusal === 'already_asked') {
    return {
      badge: t(`credits.lifecycle.${lot.lifecycle}`),
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
        hint: t('credits.refundHint.depleted', {
          credits: formatCreditAmount(lot.purchasedCredits),
        }),
      }
      : {
        badge: t('credits.refundReason.spent'),
        hint: remaining,
      };
  }
  if (refusal === 'window_closed') {
    return {
      badge: t('credits.refundReason.expired'),
      hint: remaining,
    };
  }
  return {
    // A purchase pointed at a deleted studio keeps the refusal and loses the
    // name, so it says the plain fact rather than naming an empty studio.
    badge:
      lot.designatedStudioName === null
        ? t('credits.assigned')
        : t('credits.assignedTo', { studio: lot.designatedStudioName }),
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
  const terms = usePaymentTiers(billing);

  // One instant for the whole screen, so two rows cannot land on opposite
  // sides of a window closing between them. Held across renders as well, so
  // the rows it is handed to can be memoized: a fresh Date every render is a
  // prop that never compares equal.
  const now = React.useMemo(() => new Date(), []);

  return (
    <Section
      scrollerRef={paging.scrollerRef}
      title={t('credits.section.refunds')}
      // The terms hold whatever the list is doing, so they stay on screen for
      // a reader whose list is empty or still arriving.
      //
      // The four lines the rule is published as, read back from the version
      // in force today. A summary written separately said two of them, and
      // one of the two it left out is the one a buyer acts on: a pack has to
      // be released from its Studio before it can be asked about.
      //
      // Its own read, so the list is not held up by it — and its own three
      // states for the same reason: silence here is the one outcome that
      // reads as "this screen states no rule", which is the opposite of what
      // the block is for.
      footer={
        !billing ? undefined : terms.isSuccess ? (
          <RuleLines
            data-testid='refunds-terms'
            lines={terms.data.refundLines}
          />
        ) : terms.isError ? (
          <SectionError />
        ) : (
          <Skeleton className='h-12 w-full' />
        )
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
      ) : (
        <>
          {paging.rows.length === 0 ? (
            <SectionEmpty message={t('credits.refundsEmpty')} />
          ) : (
            <>
              <Card>
                <Rows>
                  {paging.rows.map((lot) => (
                    <LotRow key={lot.id} lot={lot} userId={userId} now={now} />
                  ))}
                </Rows>
              </Card>
              <ListEnd paging={paging} />
            </>
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
  const face = faceOf(lot, refusal, t);

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
      await Promise.all([
        client.invalidateQueries({ queryKey: ['credits', 'lots', userId] }),
        client.invalidateQueries({ queryKey: ['credits', 'overview', userId] }),
        client.invalidateQueries({ queryKey: ['payment', 'history', userId] }),
      ]);
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
      void Promise.all([
        client.invalidateQueries({ queryKey: ['credits', 'lots', userId] }),
        client.invalidateQueries({ queryKey: ['credits', 'overview', userId] }),
        client.invalidateQueries({ queryKey: ['payment', 'history', userId] }),
      ]);
    },
  });

  return (
    <Row
      main={`${formatMoney(lot.paidCents, lot.currency)} · ${formatLocalDay(lot.createdAt)}`}
      sub={face.hint}
      right={
        refusal === null ? (
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
        ) : (
          // Quiet text, no border and no fill. This column is where the ask
          // button sits, so anything drawn as a block here reads as a button
          // that has been turned off — and a state the purchase is in is not
          // a control at all. Which step of the refund flow it is at, and
          // whether a decision is still coming, is what the hint line says.
          <span className='text-xs text-muted-foreground'>{face.badge}</span>
        )
      }
    />
  );
});
