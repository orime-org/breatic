// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Starting a credits checkout, once per press (inner#1490).
 *
 * One checkout is out at a time in this page, held in the run-once registry so
 * closing and reopening the confirmation keeps Pay waiting, and an unanswered
 * request is re-sent with the same key rather than opening a second Stripe
 * session. The registry carries which pack it was for, so that pack's Pay
 * spins and every other pack's Pay holds without a spin.
 */

import { t } from '@breatic/shared';

import { paymentApi, type CheckoutRequest, type CreditPack } from '@web/data/api/payment';
import { toast } from '@web/lib/toast';
import { runOnce, useRunning } from '@web/stores/task-actions-in-flight';

/** The run-once intent of a credits checkout; one per page at a time. */
const CREDITS_CHECKOUT_INTENT = 'credits:checkout';

/**
 * Which pack's checkout is out, by face value; Pay reads it.
 * @returns The pack's price in cents, or undefined when none is out.
 */
export function useCheckoutPack(): number | undefined {
  return useRunning(CREDITS_CHECKOUT_INTENT) as number | undefined;
}

/**
 * Start paying for one pack and hand the buyer over to Stripe.
 * @param pack - The pack confirmed.
 */
export function startCreditsCheckout(pack: CreditPack): void {
  void runOnce(CREDITS_CHECKOUT_INTENT, {
    scope: 'credits-checkout',
    meta: pack.priceCents,
    prepare: (): CheckoutRequest => ({
      price_cents: pack.priceCents,
      // Both ways back are derived from this one: Stripe substitutes the
      // session id into one and the server writes our own row's id into the
      // other, so the landing page can tell which way it was.
      return_url: window.location.href,
      // Nothing later in the chain knows this. A webhook carries no hint of
      // it, and the confirmation email prints the purchase time in it.
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // Reaching here means the dialog's tick is set: it is what releases
      // the button this runs from. The server stamps the instant it arrives,
      // and refuses a request that does not carry it.
      consented: true,
    }),
    send: (key, body: CheckoutRequest) => paymentApi.checkout(body, key),
    // The press stays waiting from here: the browser is leaving for Stripe,
    // and a button that comes back to life during that moment is one a
    // second tap can reach.
    onDone: ({ url }: { url: string }) => {
      window.location.assign(url);
      return 'leaving';
    },
    onFailure: () => {
      toast.error(t('credits.buy.failed'));
    },
  });
}
