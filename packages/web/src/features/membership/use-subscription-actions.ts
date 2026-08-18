// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The panel's four subscription actions (task #106, §7).
 *
 * The choice between "start a subscription" and "change the one that exists"
 * is made here from the subscription the panel was given, not from what was
 * clicked: at Stripe those are different operations, and only this side knows
 * which applies. The buttons in the table are identical either way.
 */

import * as React from 'react';
import type { SubscribableMembershipTier, SubscriptionSummary } from '@breatic/shared';

import {
  cancelSubscription,
  changeSubscriptionPlan,
  resumeSubscription,
  startSubscriptionCheckout,
} from '@web/data/api/subscription';

/** What the panel can do about a subscription. */
export interface SubscriptionActions {
  /** Take the account to a tier above its own. */
  choose: (tier: SubscribableMembershipTier) => void;
  /** Stop the membership renewing at the end of the paid period. */
  cancel: () => void;
  /** Take back a scheduled cancellation. */
  resume: () => void;
  /** Whether one of these is already running, so the controls wait. */
  busy: boolean;
}

/**
 * The situations in which the account already has a subscription to change.
 *
 * `firstPaymentUnsettled` is absent: that subscription cannot be updated at
 * Stripe, so choosing a tier there starts a fresh checkout — which is also
 * what abandons the unpaid one.
 */
const HAS_SUBSCRIPTION: ReadonlySet<SubscriptionSummary['state']> = new Set([
  'active',
  'cancelling',
  'upgradePending',
  'retrying',
]);

/**
 * Wires the panel's buttons to the subscription endpoints.
 *
 * Every action ends by reloading the page rather than patching state in place.
 * A subscription change is settled by Stripe and told to us by a webhook, so
 * what the panel should show afterwards is a server fact — and the tier in the
 * session payload, which the top bar renders, has to be re-read anyway.
 * @param subscription - The account's subscription, or null when this
 *   deployment sells none.
 * @returns The three actions and whether one is running.
 */
export function useSubscriptionActions(
  subscription: SubscriptionSummary | null,
): SubscriptionActions {
  const [busy, setBusy] = React.useState(false);

  const run = React.useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  }, []);

  const choose = React.useCallback(
    (tier: SubscribableMembershipTier) => {
      void run(async () => {
        if (subscription && HAS_SUBSCRIPTION.has(subscription.state)) {
          const result = await changeSubscriptionPlan(tier);
          // The difference was not charged, so Stripe is holding the change
          // until it is. Sending them straight to the invoice is the whole of
          // "there is a way to finish paying".
          if (result.payableInvoiceUrl) {
            window.location.assign(result.payableInvoiceUrl);
            return;
          }
          window.location.reload();
          return;
        }
        const start = await startSubscriptionCheckout(
          tier,
          window.location.href,
        );
        window.location.assign(start.url);
      });
    },
    [run, subscription],
  );

  const cancel = React.useCallback(() => {
    void run(async () => {
      await cancelSubscription();
      window.location.reload();
    });
  }, [run]);

  const resume = React.useCallback(() => {
    void run(async () => {
      await resumeSubscription();
      window.location.reload();
    });
  }, [run]);

  return { choose, cancel, resume, busy };
}
