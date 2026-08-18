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
import { ApiException } from '@web/data/api/types';
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
  const t = useTranslation();
  const [busy, setBusy] = React.useState(false);

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
        toast.error(errorMessage(err, t));
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

/**
 * What to show the reader when an action failed.
 *
 * The server's own sentence when there is one: it is already localized (every
 * `AppError` message goes through `t()`) and it says which of the refusals
 * this was — already subscribed, already on this tier, payment overdue. Only
 * when there is no such sentence, which means the request never reached us, is
 * a generic line the honest answer.
 * @param err - Whatever the action threw.
 * @param t - The translation function.
 * @returns The line to show.
 */
function errorMessage(
  err: unknown,
  t: ReturnType<typeof useTranslation>,
): string {
  if (err instanceof ApiException && err.message) return err.message;
  return t('membership.actionFailed');
}
