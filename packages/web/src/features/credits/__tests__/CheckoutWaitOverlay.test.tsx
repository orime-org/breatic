// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The cover that goes up while a purchase is being settled (task #13 §4.4).
 *
 * A buyer standing here is waiting on the result of a payment, and nothing
 * else they could start right now should begin before they know it — so the
 * page behind is unreachable and Escape does not lift the cover. The one thing
 * on it goes where the wait goes on its own once it times out, which is what
 * keeps a keyboard from being shut in here (WCAG 2.1.2).
 */

import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CheckoutWaitOverlay } from '@web/features/credits/CheckoutWaitOverlay';

describe('the cover over a purchase being settled', () => {
  it('shows nothing at all until the wait is up', () => {
    render(<CheckoutWaitOverlay open={false} onSkip={vi.fn()} />);
    expect(screen.queryByTestId('checkout-wait')).toBeNull();
  });

  it('covers the page and says what is happening', async () => {
    render(<CheckoutWaitOverlay open onSkip={vi.fn()} />);
    const cover = await screen.findByTestId('checkout-wait');
    expect(cover).toBeInTheDocument();
    expect(cover.textContent).not.toBe('');
  });

  it('offers one way on that a keyboard can reach', async () => {
    const user = userEvent.setup();
    render(<CheckoutWaitOverlay open onSkip={vi.fn()} />);
    await screen.findByTestId('checkout-wait');

    // A modal dialog holds the focus ring inside itself. With nothing in here
    // to focus, Tab has nowhere to go and the buyer is shut in until the
    // timeout — which is the trap WCAG 2.1.2 forbids. One control is what
    // makes the ring a ring rather than a dead end.
    await user.tab();
    expect(screen.getByTestId('checkout-wait-skip')).toHaveFocus();
  });

  it('takes the buyer on when that control is pressed', async () => {
    const user = userEvent.setup();
    const skip = vi.fn();
    render(<CheckoutWaitOverlay open onSkip={skip} />);
    await screen.findByTestId('checkout-wait');

    await user.click(screen.getByTestId('checkout-wait-skip'));

    // The same landing the timeout reaches: the payment is settled either way
    // by the webhook and the reconcile pass, and the purchase history is
    // where it reads as processing.
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it('stays up when Escape is pressed', async () => {
    const user = userEvent.setup();
    render(<CheckoutWaitOverlay open onSkip={vi.fn()} />);
    await screen.findByTestId('checkout-wait');

    await user.keyboard('{Escape}');

    // Nothing here refuses the key. `open` is controlled and no
    // `onOpenChange` is passed, so every way Radix has of closing itself
    // reaches a callback that is not there. Leaving is the one control's job,
    // and it says where it goes.
    expect(screen.getByTestId('checkout-wait')).toBeInTheDocument();
  });

  it('leaves nothing behind it reachable', async () => {
    const { unmount } = render(<CheckoutWaitOverlay open onSkip={vi.fn()} />);
    await screen.findByTestId('checkout-wait');

    // What makes the page underneath unclickable while a modal is up. The
    // buyer cannot start anything else before they are told what happened to
    // their money.
    expect(document.body.style.pointerEvents).toBe('none');

    unmount();
  });
});
