// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Landing after a trip to Stripe for a membership.
 *
 * Coming back is a full page load, and it lands on the page the purchase was
 * started from with nothing on screen about what happened. The address is what
 * says a purchase was attempted, and this reads it.
 *
 * What the account now holds is read rather than assumed. Stripe sends the
 * browser home the moment the payment is submitted, which is before the
 * webhook that records it arrives — so the session payload the page just
 * booted with can still name the tier the account was on. Asking the
 * membership endpoint reconciles against Stripe itself, so its answer does not
 * wait on that webhook.
 */

import * as React from 'react';
import { useSearchParams } from 'react-router-dom';

import { holdsActionableSubscription } from '@breatic/shared';

import { accountApi } from '@web/data/api/account';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { refreshCurrentUser } from '@web/stores/current-user';

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
  // One arrival is acted on once. The parameters are still in hand until the
  // rewrite below lands a tick later, and a re-render in between must not
  // report the same purchase a second time.
  const handled = React.useRef(false);

  const returned = params.get('membership') === '1';
  const cancelled = params.get('cancelled') === '1';

  React.useEffect(() => {
    if (!returned || handled.current) return;
    handled.current = true;

    const clean = new URLSearchParams(params);
    clean.delete('membership');
    clean.delete('cancelled');
    setParams(clean, { replace: true });

    if (cancelled) return;

    void (async () => {
      let membership;
      try {
        membership = await accountApi.membership();
      } catch {
        // The purchase may well have gone through; what failed is our reading
        // of it. Saying it did not would be worse than saying nothing, and
        // the panel answers the question properly when it is opened.
        toast.error(t('membership.loadFailed'));
        return;
      }

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
  }, [returned, cancelled, params, setParams, t]);
}
