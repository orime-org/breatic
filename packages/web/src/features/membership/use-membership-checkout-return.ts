// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Landing after a trip to Stripe for a membership.
 *
 * Coming back is a full page load, and it lands on the page the purchase was
 * started from with nothing on screen about what happened. The address is what
 * says a purchase was attempted, and this reads it.
 *
 * What the account now holds is confirmed rather than assumed. Stripe sends
 * the browser home the moment the payment is submitted, which is before the
 * webhook that records it arrives, so this asks the server to confirm the one
 * checkout the address names (#307).
 */

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { holdsActionableSubscription } from '@breatic/shared';

import { confirmMembershipCheckout } from '@web/data/api/subscription';
import { membershipQueryKey } from '@web/features/membership/membership-query';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { refreshCurrentUser, useCurrentUserStore } from '@web/stores/current-user';

/**
 * Report what a membership checkout came to, once, on the way back from it.
 *
 * Nothing is reported for somebody who pressed Stripe's back link. Choosing
 * not to buy is not an outcome, and saying "you cancelled" to the person who
 * just cancelled is noise.
 */
export function useMembershipCheckoutReturn(): void {
  const t = useTranslation();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const userId = useCurrentUserStore((s) => s.user?.id ?? null);
  // One arrival is acted on once. The parameters are still in hand until the
  // rewrite below lands a tick later, and a re-render in between must not
  // report the same purchase a second time.
  const handled = React.useRef(false);

  const returned = params.get('membership') === '1';
  const cancelled = params.get('cancelled') === '1';
  const sessionId = params.get('session_id');

  React.useEffect(() => {
    if (!returned || handled.current) return;
    handled.current = true;

    const clean = new URLSearchParams(params);
    clean.delete('membership');
    clean.delete('session_id');
    clean.delete('cancelled');
    setParams(clean, { replace: true });

    if (cancelled) return;

    // An address with no checkout named cannot be confirmed, which is the
    // same unknown as a failed request and gets the same words.
    if (!sessionId) {
      toast.error(t('membership.loadFailed'));
      return;
    }

    void (async () => {
      let membership;
      try {
        membership = await confirmMembershipCheckout(sessionId);
      } catch {
        // The purchase may well have gone through; what failed is confirming
        // it. Saying it did not would be worse than saying nothing. The
        // webhook still records it, and the panel shows it once that arrives.
        toast.error(t('membership.loadFailed'));
        return;
      }
      // Opening the panel next reads the confirmed answer straight away.
      queryClient.setQueryData(membershipQueryKey(userId), membership);

      const held = membership.subscription;
      if (
        held &&
        holdsActionableSubscription(held.state) &&
        membership.tier !== 'base'
      ) {
        toast.success(
          t('membership.checkout.done', {
            plan: t('membership.tierWithPeriod', {
              tier: t(`membership.tier.${membership.tier}`),
              period: t(`membership.period.${held.period}`),
            }),
          }),
        );
        // The tier the account menu names came with the session payload at
        // boot, which was before this settled.
        await refreshCurrentUser();
        return;
      }

      if (held?.state === 'firstPaymentUnsettled') {
        toast.info(t('membership.checkout.processing'));
        return;
      }

      toast.error(t('membership.checkout.failed'));
    })();
  }, [returned, cancelled, sessionId, params, setParams, queryClient, userId, t]);
}
