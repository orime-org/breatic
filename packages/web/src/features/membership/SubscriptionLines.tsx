// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import type { SubscriptionSummary } from '@breatic/shared';

import { useTranslation } from '@web/i18n/use-translation';

/** What to draw under the tier name. */
interface SubscriptionLinesProps {
  /** The account's subscription, or null when it has none. */
  subscription: SubscriptionSummary | null;
}

/**
 * What is going on with the subscription, under the tier name (#106 §13).
 *
 * One line about the money, and sometimes a second offering a way to fix
 * something. Which lines appear follows from the situation, and the situation
 * is not Stripe's status: an account that has scheduled a cancellation and one
 * that owes an upgrade's difference are both `active` there, and they need to
 * be told opposite things.
 *
 * Deliberately says nothing at all for an account with no subscription. There
 * is nothing to report, and "you are on the free plan" is already the tier
 * name directly above.
 * @param props - The subscription to describe.
 * @param props.subscription - The account's subscription, or null.
 * @returns The lines, or nothing.
 */
export const SubscriptionLines = React.memo(function SubscriptionLines({
  subscription,
}: SubscriptionLinesProps): React.JSX.Element | null {
  const t = useTranslation();
  if (!subscription || subscription.state === 'none') return null;

  const date = formatDate(subscription.currentPeriodEnd);
  const notice = noticeKeyFor(subscription.state);

  return (
    <>
      {billingLine(subscription, date, t)}
      {notice ? (
        <div
          className='flex items-center gap-2 text-sm text-foreground-secondary'
          data-testid='subscription-notice'
        >
          <span>{t(notice)}</span>
          {subscription.payableInvoiceUrl ? (
            <a
              href={subscription.payableInvoiceUrl}
              target='_blank'
              rel='noopener noreferrer'
              data-testid='subscription-pay-now'
              className='underline underline-offset-2'
            >
              {t('membership.payNow')}
            </a>
          ) : null}
        </div>
      ) : null}
    </>
  );
});

/**
 * The line about the money.
 *
 * A scheduled cancellation gets its own sentence rather than the next-charge
 * one: on that date nothing is charged, it ends. Saying "next charge" there
 * would be a claim about a payment that is not going to happen.
 * @param subscription - The subscription being described.
 * @param date - Its period end, already formatted, or null.
 * @param t - The translation function.
 * @returns The line, or nothing when there is no date worth showing.
 */
function billingLine(
  subscription: SubscriptionSummary,
  date: string | null,
  t: (key: string, params?: Record<string, string>) => string,
): React.JSX.Element | null {
  if (!date) return null;
  // Nothing is being collected on that date in either of these, so neither
  // gets a date line: the notice below says what is actually happening.
  if (subscription.state === 'retrying') return null;
  if (subscription.state === 'firstPaymentUnsettled') return null;

  const key = subscription.cancelAtPeriodEnd
    ? 'membership.endsOn'
    : 'membership.nextCharge';
  return (
    <div
      className='text-sm text-muted-foreground'
      data-testid='subscription-billing-line'
    >
      {t(key, { date })}
    </div>
  );
}

/**
 * Which notice a situation owes, if any.
 * @param state - The situation the account is in.
 * @returns The copy key, or null when there is nothing to say.
 */
function noticeKeyFor(state: SubscriptionSummary['state']): string | null {
  switch (state) {
    case 'firstPaymentUnsettled':
      return 'membership.notice.firstPaymentPending';
    case 'upgradePending':
      return 'membership.notice.upgradePending';
    case 'retrying':
      return 'membership.notice.paymentOverdue';
    // Nothing is outstanding in any of these. `unexpected` is a state we never
    // create, so there is no true sentence to write about it either.
    case 'none':
    case 'active':
    case 'cancelling':
    case 'unexpected':
      return null;
  }
}

/**
 * Formats an ISO date the way the reader's locale writes dates.
 * @param iso - The date, or null.
 * @returns The formatted date, or null.
 */
function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
