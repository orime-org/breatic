// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The "buy credits" screen, and the confirmation step in front of it
 * (task #13 §4.7).
 *
 * This screen only **starts** a purchase. How far along a payment is belongs to
 * the purchase history, so half of what is asserted here is what is *not* on
 * this screen.
 *
 * The consent tick lives on the confirmation dialog, not at the bottom of the
 * screen: it confirms this one purchase rather than standing as a notice on the
 * page. Until it is ticked, the pay button stays disabled.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CreditOverview } from '@breatic/shared';

import { BuySection } from '@web/features/credits/sections/BuySection';

const fetchTiers = vi.fn();
const startCheckout = vi.fn();
vi.mock('@web/data/api/payment', () => ({
  paymentApi: {
    tiers: () => fetchTiers(),
    checkout: (...args: unknown[]) => startCheckout(...args),
  },
}));

const PACKS = [
  { name: '830 Credits', credits: 830, priceCents: 1000, currency: 'usd' },
  { name: '1,700 Credits', credits: 1700, priceCents: 2000, currency: 'usd' },
  { name: '4,320 Credits', credits: 4320, priceCents: 5000, currency: 'usd' },
  { name: '8,690 Credits', credits: 8690, priceCents: 10000, currency: 'usd' },
  { name: '43,660 Credits', credits: 43660, priceCents: 50000, currency: 'usd' },
];

beforeEach(() => {
  vi.clearAllMocks();
  fetchTiers.mockResolvedValue({ packs: PACKS, confirmTimeoutMs: 15000 });
  startCheckout.mockResolvedValue({ url: 'https://checkout.stripe.test/x' });
});

/**
 * An overview with nothing in it: this screen asks about packs, not balances.
 * @param over - Fields to override.
 * @returns The overview.
 */
function overview(over: Partial<CreditOverview> = {}): CreditOverview {
  return {
    assignedCredits: 0,
    unassignedCredits: 0,
    billing: true,
    studios: [],
    ...over,
  };
}

/**
 * Render the buy screen.
 * @param over - Overview fields to override.
 * @returns The render result.
 */
function renderBuy(over: Partial<CreditOverview> = {}): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BuySection overview={overview(over)} />
    </QueryClientProvider>,
  );
}

describe('the buy screen', () => {
  it('lists every pack on offer', async () => {
    renderBuy();
    await waitFor(() => {
      expect(screen.getAllByTestId('credit-pack')).toHaveLength(5);
    });
  });

  it('gives each pack its price and what it grants', async () => {
    renderBuy();
    const packs = await screen.findAllByTestId('credit-pack');
    expect(packs[0]!.textContent).toContain('830');
    expect(packs[0]!.textContent).toContain('10');
    expect(packs[4]!.textContent).toContain('43,660');
  });

  it('says the price excludes tax and that credits need assigning', async () => {
    renderBuy();
    await screen.findAllByTestId('credit-pack');
    expect(screen.getByTestId('buy-tax-notice')).toBeInTheDocument();
    expect(screen.getByTestId('buy-assign-notice')).toBeInTheDocument();
  });

  it('shows nothing about a payment in flight', async () => {
    renderBuy();
    await screen.findAllByTestId('credit-pack');
    // Where a purchase stands is the purchase history's job. This screen
    // starting to answer it would give a buyer two places to look.
    expect(screen.queryByTestId('purchase-status')).toBeNull();
  });

  it('offers nothing to buy where this deployment sells nothing', async () => {
    renderBuy({ billing: false });
    await waitFor(() => {
      expect(screen.queryAllByTestId('credit-pack')).toHaveLength(0);
    });
    expect(fetchTiers).not.toHaveBeenCalled();
  });
});

describe('the confirmation before paying', () => {
  it('opens on the pack that was chosen, and says what it is', async () => {
    const user = userEvent.setup();
    renderBuy();
    const packs = await screen.findAllByTestId('credit-pack');
    await user.click(within(packs[1]!).getByRole('button'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('1,700');
    expect(dialog.textContent).toContain('20');
    expect(screen.getByTestId('confirm-tax-note')).toBeInTheDocument();
  });

  it('holds the pay button until the consent is ticked', async () => {
    const user = userEvent.setup();
    renderBuy();
    const packs = await screen.findAllByTestId('credit-pack');
    await user.click(within(packs[0]!).getByRole('button'));

    const pay = await screen.findByTestId('confirm-pay');
    expect(pay).toBeDisabled();

    await user.click(screen.getByTestId('confirm-consent'));
    expect(pay).toBeEnabled();
  });

  it('starts the checkout for the chosen pack and hands the buyer over', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'https://app.test/s/mine' });
    try {
      renderBuy();
      const packs = await screen.findAllByTestId('credit-pack');
      await user.click(within(packs[2]!).getByRole('button'));
      await user.click(await screen.findByTestId('confirm-consent'));
      await user.click(screen.getByTestId('confirm-pay'));

      await waitFor(() => {
        expect(startCheckout).toHaveBeenCalledTimes(1);
      });
      expect(startCheckout.mock.calls[0]![0]).toMatchObject({
        price_cents: 5000,
      });
      await waitFor(() => {
        expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/x');
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends the buyer time zone along, since nothing later knows it', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('location', { assign: vi.fn(), href: 'https://app.test/s/mine' });
    try {
      renderBuy();
      const packs = await screen.findAllByTestId('credit-pack');
      await user.click(within(packs[0]!).getByRole('button'));
      await user.click(await screen.findByTestId('confirm-consent'));
      await user.click(screen.getByTestId('confirm-pay'));

      await waitFor(() => {
        expect(startCheckout).toHaveBeenCalled();
      });
      const body = startCheckout.mock.calls[0]![0] as { time_zone: string };
      expect(body.time_zone).toBe(
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('starts each purchase unticked', async () => {
    const user = userEvent.setup();
    renderBuy();
    const packs = await screen.findAllByTestId('credit-pack');

    await user.click(within(packs[0]!).getByRole('button'));
    await user.click(await screen.findByTestId('confirm-consent'));
    await user.keyboard('{Escape}');

    await user.click(within(packs[1]!).getByRole('button'));
    // Consent belongs to one purchase. Carrying a tick over to the next would
    // record an agreement the buyer gave about something else.
    expect(await screen.findByTestId('confirm-pay')).toBeDisabled();
  });
});
