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
import { refreshCurrentUser } from '@web/stores/current-user';
import { useTranslation } from '@web/i18n/use-translation';
import {
  holdsActionableSubscription,
  type MembershipOffer,
  type SubscriptionSummary,
} from '@breatic/shared';

import {
  cancelSubscription,
  changeSubscriptionPlan,
  resumeSubscription,
  startSubscriptionCheckout,
} from '@web/data/api/subscription';
import { MEMBERSHIP_QUERY_ROOT } from '@web/features/membership/membership-query';

/** Which of the panel's actions is running. */
export type PendingSubscriptionAction =
  | { readonly kind: 'choose'; readonly offer: MembershipOffer }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'resume' };

/** What the panel can do about a subscription. */
export interface SubscriptionActions {
  /** Take the account to another offer: a tier, a period, or both. */
  choose: (offer: MembershipOffer) => void;
  /** Stop the membership renewing at the end of the paid period. */
  cancel: () => void;
  /** Take back a scheduled cancellation. */
  resume: () => void;
  /** Whether one of these is already running, so the controls wait. */
  busy: boolean;
  /** The one that is running, so its own control can say so. */
  pending: PendingSubscriptionAction | null;
}

/**
 * Whether a failed request was refused as a conflict with the account's state.
 * @param err - What the request threw.
 * @returns Whether the server answered 409.
 */
function isConflict(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status?: unknown }).status === 409
  );
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
 * @returns The three actions, whether one is running, and which.
 */
export function useSubscriptionActions(
  subscription: SubscriptionSummary | null,
): SubscriptionActions {
  const t = useTranslation();
  const queryClient = useQueryClient();
  const [pending, setPending] = React.useState<PendingSubscriptionAction | null>(
    null,
  );

  // Re-reads the panel's own data and leaves the page alone.
  //
  // Cancelling and resuming do not move the tier — `cancelling` still earns
  // the tier it was paid for, and the server sends nothing but
  // `cancel_at_period_end` — so there is nothing outside this panel to
  // refresh. Reloading the whole page for them closed the panel the reader
  // was standing in, threw away whatever page was underneath it, and left no
  // sign that anything had happened.
  const refreshPanel = React.useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: MEMBERSHIP_QUERY_ROOT });
  }, [queryClient]);

  // `work` answers 'leaving' once it has sent the browser to another page.
  // The action stays pending from then on: the page is going, and a button
  // that comes back to life during that moment is one a second tap can reach.
  const run = React.useCallback(
    async (
      action: PendingSubscriptionAction,
      work: () => Promise<'leaving' | void>,
    ) => {
      setPending(action);
      let leaving = false;
      try {
        leaving = (await work()) === 'leaving';
      } catch (err) {
        // Every one of these can fail without anything being broken: two tabs
        // open on this panel and one of them subscribes first makes the other
        // one's click a 409. Without this the click did nothing at all — no
        // message, no explanation, the button simply came back — and the
        // reader had no way to tell a refusal from a dead app.
        toast.error(serverMessage(err, t('membership.actionFailed')));
        // A conflict means the account is not in the state this panel showed.
        // Before refusing a checkout the server may have asked Stripe and
        // stored a subscription it found still live, so the panel and the
        // avatar menu re-read rather than keep offering what it refused.
        if (isConflict(err)) {
          await Promise.all([refreshPanel(), refreshCurrentUser()]);
        }
      } finally {
        if (!leaving) setPending(null);
      }
    },
    [t, refreshPanel],
  );

  const choose = React.useCallback(
    (offer: MembershipOffer) => {
      void run({ kind: 'choose', offer }, async () => {
        if (subscription && holdsActionableSubscription(subscription.state)) {
          const result = await changeSubscriptionPlan(offer);
          // The difference was not charged, so Stripe is holding the change
          // until it is. Sending them straight to the invoice is the whole of
          // "there is a way to finish paying".
          if (result.payableInvoiceUrl) {
            window.location.assign(result.payableInvoiceUrl);
            return 'leaving';
          }
          window.location.reload();
          return 'leaving';
        }
        const start = await startSubscriptionCheckout(
          offer,
          window.location.href,
        );
        window.location.assign(start.url);
        return 'leaving';
      });
    },
    [run, subscription],
  );

  const cancel = React.useCallback(() => {
    void run({ kind: 'cancel' }, async () => {
      await cancelSubscription();
      await refreshPanel();
    });
  }, [run, refreshPanel]);

  const resume = React.useCallback(() => {
    void run({ kind: 'resume' }, async () => {
      await resumeSubscription();
      await refreshPanel();
    });
  }, [run, refreshPanel]);

  return { choose, cancel, resume, busy: pending !== null, pending };
}
