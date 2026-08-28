// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PurchaseRow } from '@breatic/shared';

import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { paymentApi } from '@web/data/api/payment';
import {
  Card,
  ListEnd,
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
import { toast } from '@web/lib/toast';

/** Whose purchases, and whether billing is on at all. */
interface PurchasesSectionProps {
  /** The signed-in account, for the query key. */
  userId: string | null;
  /** Whether this deployment charges for generation at all. */
  billing: boolean;
}

/**
 * Every purchase this account has made, newest first.
 *
 * It lists payments, so a purchase still processing and one the buyer
 * abandoned are both here — those are what somebody comes to this screen to
 * ask about. Neither has credits behind it, so the figures that come from a
 * lot are absent on those rows rather than shown as zero.
 * @param props - The account and whether billing is on.
 * @param props.userId - The signed-in account, for the query key.
 * @param props.billing - Whether this deployment charges at all.
 * @returns The section.
 */
export function PurchasesSection({
  userId,
  billing,
}: PurchasesSectionProps): React.JSX.Element {
  const t = useTranslation();
  const read = React.useCallback(
    (cursor: string | undefined) => paymentApi.history(cursor),
    [],
  );
  const paging = useCreditsPaging<PurchaseRow>({
    // Its own key. The assign and refund screens read the lots and act on lot
    // ids; a page of payments in their cache would give them rows with no lot
    // and ids the refund action cannot use.
    queryKey: ['payment', 'history', userId],
    read,
    enabled: billing && userId !== null,
  });

  const unassigned = paging.rows.filter(
    (purchase) =>
      purchase.lifecycle === 'active' && purchase.designatedStudioId === null,
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
              {paging.rows.map((purchase) => (
                <PurchaseLine
                  key={purchase.paymentId}
                  purchase={purchase}
                  userId={userId}
                />
              ))}
            </Rows>
          </Card>
          <ListEnd
            sentinelRef={paging.sentinelRef}
            loading={paging.isFetchingNextPage}
            more={paging.hasNextPage}
            failed={paging.pageFailed}
          />
          {/* Counted only once the list is read through. While there is
              another page this figure is of the pages fetched so far, and a
              number that climbs as you scroll says less than none. */}
          {unassigned === 0 || paging.hasNextPage ? null : (
            <Notice
              data-testid='unassigned-notice'
              title={t('credits.unassignedNotice.title', { count: unassigned })}
              body={t('credits.unassignedNotice.body')}
            />
          )}
        </>
      )}
    </Section>
  );
}

/** Which badge each state carries. */
const STATUS_LABEL: Record<string, string> = {
  completed: 'credits.purchase.landed',
  pending: 'credits.purchase.processing',
  expired: 'credits.purchase.expired',
  failed: 'credits.purchase.failed',
};

/**
 * The states from which nothing further arrives.
 *
 * A purchase in one of these was never charged and will never grant credits,
 * whatever figures its row carries — Stripe works a total out the moment the
 * buyer gives it an address, and a bank can refuse days later. So both cells
 * ask this first: "shown once it lands" describes a future that will not
 * happen, and a figure would name a sum nobody was charged.
 */
const OVER: ReadonlySet<string> = new Set(['expired', 'failed']);

/** The purchase to draw, and whose list it sits in. */
interface PurchaseLineProps {
  /** The purchase. */
  purchase: PurchaseRow;
  /** The signed-in account, for reading the list again after a resend. */
  userId: string | null;
}

/**
 * One purchase: what it cost, when, where it stands, and what is left of it.
 *
 * Every row says which of the four states it is in. The amount cell asks
 * whether this purchase ended without being charged before asking whether
 * Stripe has worked a figure out; where the credits point asks whether there
 * is a lot behind this purchase at all.
 * @param props - The purchase and the account.
 * @param props.purchase - The purchase.
 * @param props.userId - The signed-in account.
 * @returns The row.
 */
const PurchaseLine = React.memo(function PurchaseLine({
  purchase,
  userId,
}: PurchaseLineProps): React.JSX.Element {
  const t = useTranslation();
  const client = useQueryClient();
  const [sending, setSending] = React.useState(false);
  // What Stripe worked out, once it has. A purchase that landed has it, and so
  // does one whose delayed payment is still clearing — Stripe holds the final
  // figure from the moment the buyer typed their address. Carrying one says
  // nothing about whether the money moved, which is why `over` is asked first.
  const charged = purchase.totalCents;
  const over = OVER.has(purchase.status);
  const statusKey = STATUS_LABEL[purchase.status];

  const resend = React.useCallback(async (): Promise<void> => {
    setSending(true);
    try {
      const { sent } = await paymentApi.resendConfirmation(purchase.paymentId);
      if (sent) toast.success(t('credits.purchase.resendSent'));
      else toast.error(t('credits.purchase.resendFailed'));
    } catch {
      toast.error(t('credits.purchase.resendFailed'));
    } finally {
      setSending(false);
      // Whether the control is still offered is decided from the row, and the
      // row just moved. Left as it was, the next tap would be refused by the
      // server and the buyer would be told a letter that did go out did not.
      void client.invalidateQueries({ queryKey: ['payment', 'history', userId] });
    }
  }, [client, purchase.paymentId, t, userId]);

  return (
    <Row
      data-testid='purchase-row'
      main={
        <>
          {/* Whether anything was taken comes first. A purchase that ended
                can still carry a figure — Stripe works one out the moment the
                buyer gives it an address, and a bank can refuse days later —
                and printing it would name a sum nobody was charged.
                Otherwise: what the card was charged, tax included, which is
                the figure a buyer matches against a statement; or, before
                Stripe has one, the pre-tax price said plainly, which tells
                them more than nothing does. */}
          {over
            ? t('credits.purchase.notCharged')
            : charged !== null
              ? formatMoney(charged, purchase.currency)
              : t('credits.purchase.beforeTax', {
                amount: formatMoney(purchase.amountCents, purchase.currency),
              })}{' '}
            · {formatLocalDay(purchase.createdAt)}
          {statusKey === undefined ? null : (
            <Badge
              data-testid='purchase-status'
              variant='secondary'
              className='ml-2 align-middle'
            >
              {t(statusKey)}
            </Badge>
          )}
        </>
      }
      sub={
        // Where it points is a question about credits, and a purchase with no
        // lot behind it has none to point anywhere. That is the question, not
        // which states it is in: "Unassigned" on a purchase that cannot be
        // assigned — abandoned, failed, or still being paid for — reads as
        // something left to do.
        purchase.lifecycle === null
          ? undefined
          : purchase.designatedStudioName === null
            ? t('credits.unassigned')
            : t('credits.assignedTo', {
              studio: purchase.designatedStudioName,
            })
      }
      right={
        <>
          {purchase.remainingCredits === null ? (
          // Nothing is coming to an abandoned or failed purchase, so this
          // cell stays empty rather than promising a figure.
            over ? null : (
              <span className='block text-xs text-muted-foreground'>
                {t('credits.purchase.creditsOnArrival')}
              </span>
            )
          ) : (
            <>
              <span
                data-testid='purchase-remaining'
                className='block text-sm font-semibold'
              >
                {formatCreditAmount(purchase.remainingCredits)}
              </span>
              <span className='block text-xs text-muted-foreground'>
                {t('credits.ofPurchased', {
                  amount: formatCreditAmount(purchase.creditsGranted),
                })}
              </span>
            </>
          )}
          {purchase.canResend ? (
            <Button
              data-testid='resend-confirmation'
              variant='outline'
              size='sm'
              className='mt-1'
              disabled={sending}
              onClick={resend}
            >
              {t('credits.purchase.resend')}
            </Button>
          ) : null}
        </>
      }
    />
  );
});
