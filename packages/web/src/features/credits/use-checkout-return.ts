// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Landing after a trip to Stripe.
 *
 * Coming back is a full page load, so nothing the page held before the buyer
 * left is still there — the credits overlay's own open flag is false on
 * arrival. What brings them back to the right place is the address, and this
 * reads it.
 *
 * Two ways back come off one `return_url` and land on one route, so each
 * carries what says which it was. Paying carries the session id Stripe
 * substitutes; pressing Back carries our own row's id, which the server wrote
 * into that URL before the session existed. Telling them apart is what makes
 * the Back button abandon a purchase instead of confirming one.
 */

import * as React from 'react';
import { useSearchParams } from 'react-router-dom';

import { paymentApi } from '@web/data/api/payment';
import type { CreditsSectionId } from '@web/features/credits/credits-sections';

/** How long to keep the buyer behind the wait. */
interface CheckoutReturnOptions {
  /** The server's answer, which is where that value lives. */
  confirmTimeoutMs: number;
}

/** Where the page stands on arrival. */
interface CheckoutReturnState {
  /** Whether the full-screen wait is up. */
  waiting: boolean;
  /** Whether the credits overlay should be showing. */
  overlayOpen: boolean;
  /** Which of its sections to open on, or null for its own default. */
  initialSection: CreditsSectionId | null;
  /** Closes the overlay, for the caller to hand to it. */
  close: () => void;
}

/**
 * Read the address, settle or abandon what it names, and say where to land.
 *
 * The wait has an exit that does not depend on an answer: past the timeout it
 * comes down anyway and the buyer lands in their purchase history, where that
 * payment reads as processing. It is settled either way — the webhook and the
 * reconcile pass both reach it — and a spinner that might never stop is worse
 * than a true "processing".
 * @param options - How long to wait.
 * @param options.confirmTimeoutMs - The wait, from the server.
 * @returns What to show.
 */
export function useCheckoutReturn(
  options: CheckoutReturnOptions,
): CheckoutReturnState {
  const [params, setParams] = useSearchParams();
  const [waiting, setWaiting] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [section, setSection] = React.useState<CreditsSectionId | null>(null);
  // One arrival is acted on once. A re-render must not confirm a purchase a
  // second time, and the parameters are still in hand until the URL is
  // rewritten a tick later.
  const handled = React.useRef(false);

  const asked = params.get('credits') === '1';
  const sessionId = params.get('session_id');
  const cancelled = params.get('cancelled') === '1';
  const paymentId = params.get('payment_id');
  const { confirmTimeoutMs } = options;

  React.useEffect(() => {
    if (!asked || handled.current) return;
    handled.current = true;

    /** Take the return parameters back out of the address. */
    const clearParams = (): void => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const key of ['credits', 'session_id', 'cancelled', 'payment_id']) {
            next.delete(key);
          }
          return next;
        },
        // Through the router rather than `history.replaceState`: this app
        // routes with `createBrowserRouter`, which keeps its own bookkeeping in
        // the history state and works out navigation deltas from it. Replacing
        // that state wholesale makes the guard that watches for leaving a
        // project fail silently.
        { replace: true },
      );
    };

    if (cancelled && paymentId !== null) {
      // Nothing to wait for: the buyer said they were done, and the answer
      // changes nothing they are looking at.
      setOpen(true);
      setSection('buy');
      void paymentApi.cancel(paymentId).catch(() => undefined);
      clearParams();
      return;
    }

    if (sessionId !== null) {
      setWaiting(true);
      let landed = false;
      /** Come out from behind the wait, once. */
      const land = (): void => {
        if (landed) return;
        landed = true;
        setWaiting(false);
        setOpen(true);
        setSection('lots');
        clearParams();
      };
      const timer = setTimeout(land, confirmTimeoutMs);
      void paymentApi
        .confirm(sessionId)
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(timer);
          land();
        });
      return;
    }

    // `?credits=1` on its own: somebody was sent to their credits, with
    // nothing to settle.
    setOpen(true);
  }, [asked, cancelled, paymentId, sessionId, confirmTimeoutMs, setParams]);

  const close = React.useCallback(() => {
    setOpen(false);
    setSection(null);
  }, []);

  return { waiting, overlayOpen: open, initialSection: section, close };
}
