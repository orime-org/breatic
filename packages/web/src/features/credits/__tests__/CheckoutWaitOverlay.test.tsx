// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The cover that goes up while a purchase is being settled (task #13 §4.4).
 *
 * It takes no input. A buyer standing here is waiting on the result of a
 * payment, and nothing else they could start right now should begin before
 * they know it. Nothing is drawn to press, and `open` being controlled with
 * no `onOpenChange` is what makes every way out of a dialog reach nothing.
 * What takes it down is the hook that raised it.
 */

import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CheckoutWaitOverlay } from '@web/features/credits/CheckoutWaitOverlay';

describe('the cover over a purchase being settled', () => {
  it('shows nothing at all until the wait is up', () => {
    render(<CheckoutWaitOverlay open={false} />);
    expect(screen.queryByTestId('checkout-wait')).toBeNull();
  });

  it('covers the page and says what is happening', async () => {
    render(<CheckoutWaitOverlay open />);
    const cover = await screen.findByTestId('checkout-wait');
    expect(cover).toBeInTheDocument();
    expect(cover.textContent).not.toBe('');
  });

  it('draws no control at all', async () => {
    render(<CheckoutWaitOverlay open />);
    const cover = await screen.findByTestId('checkout-wait');
    // The close X is drawn by `DialogHeader`, which this cover does not use.
    // Adding one would put a control in front of a buyer whose only correct
    // move is to wait, so the assertion is that there is nothing here to
    // press rather than that whatever is here is hidden.
    expect(cover.querySelector('button')).toBeNull();
  });

  it('stays up when Escape is pressed', async () => {
    const user = userEvent.setup();
    render(<CheckoutWaitOverlay open />);
    await screen.findByTestId('checkout-wait');

    await user.keyboard('{Escape}');

    // Nothing here refuses the key. `open` is controlled and no
    // `onOpenChange` is passed, so every way Radix has of closing itself
    // reaches a callback that is not there.
    expect(screen.getByTestId('checkout-wait')).toBeInTheDocument();
  });

  it('leaves nothing behind it reachable', async () => {
    const { unmount } = render(<CheckoutWaitOverlay open />);
    await screen.findByTestId('checkout-wait');

    // What makes the page underneath unclickable while a modal is up. The
    // buyer cannot start anything else before they are told what happened to
    // their money.
    expect(document.body.style.pointerEvents).toBe('none');

    unmount();
  });
});
