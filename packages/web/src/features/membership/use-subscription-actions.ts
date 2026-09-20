// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The panel's four subscription actions (task #106, §7).
 *
 * The choice between "start a subscription" and "change the one that exists"
 * is made here from the subscription the panel was given, not from what was
 * clicked: at Stripe those are different operations, and only this side knows
 * which applies. The buttons in the table are identical either way.
 */

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { serverMessage } from '@web/data/api/server-message';
import { toast } from '@web/lib/toast';
import { useTranslation } from '@web/i18n/use-translation';
import {
  holdsActionableSubscription,
  type SubscribableMembershipTier,
  type SubscriptionSummary,
} from '@breatic/shared';

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
 * Wires the panel's buttons to the subscription endpoints.
 *
 * None of them patch state in place: what the panel should show afterwards is
 * a server fact, settled by Stripe and told to us by a webhook.
 *
 * How much gets re-read differs, because how much changed differs. Choosing a
 * tier moves the tier itself, which the top bar renders out of the session
 * payload, so that one reloads the page. Cancelling and resuming move no tier
 * at all — they only set a flag on the subscription — so they re-read this
 * panel's own query and leave the reader where they were.
 * @param subscription - The account's subscription, or null when this
 *   deployment sells none.
 * @returns The three actions and whether one is running.
 */
export function useSubscriptionActions(
  subscription: SubscriptionSummary | null,
): SubscriptionActions {
  const t = useTranslation();
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState(false);

  // Re-reads the panel's own data and leaves the page alone.
  //
  // Cancelling and resuming do not move the tier — `cancelling` still earns
  // the tier it was paid for, and the server sends nothing but
  // `cancel_at_period_end` — so there is nothing outside this panel to
  // refresh. Reloading the whole page for them closed the panel the reader
  // was standing in, threw away whatever page was underneath it, and left no
  // sign that anything had happened.
  const refreshPanel = React.useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: ['account', 'membership'],
    });
  }, [queryClient]);

  const run = React.useCallback(
    async (work: () => Promise<void>) => {
      setBusy(true);
      try {
        await work();
      } catch (err) {
        // Every one of these can fail without anything being broken: two tabs
        // open on this panel and one of them subscribes first makes the other
        // one's click a 409. Without this the click did nothing at all — no
        // message, no explanation, the button simply came back — and the
        // reader had no way to tell a refusal from a dead app.
        toast.error(serverMessage(err, t('membership.actionFailed')));
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const choose = React.useCallback(
    (tier: SubscribableMembershipTier) => {
      void run(async () => {
        if (subscription && holdsActionableSubscription(subscription.state)) {
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
      await refreshPanel();
    });
  }, [run, refreshPanel]);

  const resume = React.useCallback(() => {
    void run(async () => {
      await resumeSubscription();
      await refreshPanel();
    });
  }, [run, refreshPanel]);

  return { choose, cancel, resume, busy };
}
