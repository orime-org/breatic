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
  type CheckoutStart,
  type PlanChange,
} from '@web/data/api/subscription';
import { runOnce, useRunning } from '@web/stores/task-actions-in-flight';
import { ApiException } from '@web/data/api/types';
import { MEMBERSHIP_QUERY_ROOT } from '@web/features/membership/membership-query';

/** The run-once intent of a checkout or a plan change; one per page at a time. */
const MEMBERSHIP_INTENT = 'membership';

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
 * Wires the panel's buttons to the subscription endpoints.
 *
 * None of them patch state in place: what the panel should show afterwards is
 * a server fact, settled by Stripe and stored from its answer or its webhook.
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
  // Cancel and resume are this panel's own; a checkout or a plan change is
  // one press of the account, held in the run-once registry so a reopened
  // panel finds it still waiting (inner#1490).
  const [ownPending, setPending] = React.useState<PendingSubscriptionAction | null>(
    null,
  );
  const choosing = useRunning(MEMBERSHIP_INTENT) as MembershipOffer | undefined;
  const pending: PendingSubscriptionAction | null =
    ownPending ?? (choosing === undefined ? null : { kind: 'choose', offer: choosing });

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

  // Every one of these can fail without anything being broken: two tabs open
  // on this panel and one of them subscribes first makes the other one's
  // click a 409. Without a message the click did nothing at all — the button
  // simply came back — and the reader had no way to tell a refusal from a
  // dead app.
  const refused = React.useCallback(
    async (err: unknown): Promise<void> => {
      toast.error(serverMessage(err, t('membership.actionFailed')));
      // A conflict means the account is not in the state this panel showed.
      // Before refusing a checkout the server may have asked Stripe and
      // stored a subscription it found still live, so the panel and the
      // avatar menu re-read rather than keep offering what it refused.
      if (err instanceof ApiException && err.status === 409) {
        await Promise.all([refreshPanel(), refreshCurrentUser()]);
      }
    },
    [t, refreshPanel],
  );

  const choose = React.useCallback(
    (offer: MembershipOffer) => {
      if (ownPending !== null) return;
      const changing = subscription !== null && holdsActionableSubscription(subscription.state);
      // `leaving` once it has sent the browser to another page: the press
      // stays waiting from then on, since a button that comes back to life
      // while the page goes is one a second tap can reach.
      void runOnce(MEMBERSHIP_INTENT, {
        scope: 'membership',
        meta: offer,
        prepare: () => ({ offer, returnUrl: window.location.href }),
        send: (key, body: { offer: MembershipOffer; returnUrl: string }) =>
          changing
            ? changeSubscriptionPlan(body.offer, key)
            : startSubscriptionCheckout(body.offer, body.returnUrl, key),
        onDone: (answer: PlanChange | CheckoutStart) => {
          if ('url' in answer) {
            window.location.assign(answer.url);
            return 'leaving';
          }
          // The difference was not charged, so Stripe is holding the change
          // until it is. Sending them straight to the invoice is the whole of
          // "there is a way to finish paying".
          if (answer.payableInvoiceUrl) {
            window.location.assign(answer.payableInvoiceUrl);
            return 'leaving';
          }
          window.location.reload();
          return 'leaving';
        },
        onFailure: (err) => {
          void refused(err);
        },
      });
    },
    [ownPending, subscription, refused],
  );

  // Cancel and resume run here; they wait while a checkout is out, which is
  // what `busy` says to their buttons.
  const runOwn = React.useCallback(
    async (action: PendingSubscriptionAction, work: () => Promise<void>) => {
      if (choosing !== undefined) return;
      setPending(action);
      try {
        await work();
      } catch (err) {
        await refused(err);
      } finally {
        setPending(null);
      }
    },
    [choosing, refused],
  );

  const cancel = React.useCallback(() => {
    void runOwn({ kind: 'cancel' }, async () => {
      await cancelSubscription();
      await refreshPanel();
    });
  }, [runOwn, refreshPanel]);

  const resume = React.useCallback(() => {
    void runOwn({ kind: 'resume' }, async () => {
      await resumeSubscription();
      await refreshPanel();
    });
  }, [runOwn, refreshPanel]);

  return { choose, cancel, resume, busy: pending !== null, pending };
}
