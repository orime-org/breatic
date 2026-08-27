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
 * The refund-rule tick lives on the confirmation dialog, not at the bottom of
 * the screen: it belongs to this one purchase rather than standing as a notice
 * on the page. Until it is ticked, the pay button stays disabled.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setLocale } from '@breatic/shared';
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
  { credits: 830, priceCents: 1000, currency: 'usd' },
  { credits: 1700, priceCents: 2000, currency: 'usd' },
  { credits: 4320, priceCents: 5000, currency: 'usd' },
  { credits: 8690, priceCents: 10000, currency: 'usd' },
  { credits: 43660, priceCents: 50000, currency: 'usd' },
];

/** The refund rule, as the server hands it over. */
const REFUND_LINES = [
  'Bought within 30 days and spent nothing? Refunded in full to the card.',
  'Spend any one of them and this purchase can no longer be refunded.',
  'Past 30 days, no refund.',
];

beforeEach(() => {
  vi.clearAllMocks();
  fetchTiers.mockResolvedValue({
    packs: PACKS,
    confirmTimeoutMs: 15000,
    refundLines: REFUND_LINES,
  });
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

  it('shows the refund rule in full before anything is bought', async () => {
    // The confirmation dialog asks the buyer to agree to it, so it has to be
    // readable on the screen that leads there.
    renderBuy();
    await screen.findAllByTestId('credit-pack');
    const rule = screen.getByTestId('buy-refund-rule');
    for (const line of REFUND_LINES) {
      expect(rule.textContent).toContain(line);
    }
  });

  it('asks again in the new language when the language changes', async () => {
    // The refund rule comes back translated, so the language is part of what
    // was asked for. Left out of the query key, that block stays in the
    // previous language until the answer goes stale — up to five minutes.
    renderBuy();
    await screen.findAllByTestId('credit-pack');
    expect(fetchTiers).toHaveBeenCalledTimes(1);

    await act(async () => {
      setLocale('zh-CN');
    });
    await waitFor(() => {
      expect(fetchTiers).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      setLocale('en');
    });
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

  it('carries the rule it asks the buyer to have read', async () => {
    const user = userEvent.setup();
    renderBuy();
    const packs = await screen.findAllByTestId('credit-pack');
    await user.click(within(packs[0]!).getByRole('button'));

    // The tick says the buyer has read this, and a modal dialog covers what is
    // behind it — the copy on the screen goes under an 80%-black scrim and out
    // of the accessibility tree at the same time. Asking someone to confirm a
    // rule they cannot see or hear is asking them to take our word for it.
    const rule = await screen.findByTestId('confirm-refund-rule');
    for (const line of REFUND_LINES) {
      expect(rule.textContent).toContain(line);
    }
  });

  it('holds the pay button until the refund rule is ticked', async () => {
    const user = userEvent.setup();
    renderBuy();
    const packs = await screen.findAllByTestId('credit-pack');
    await user.click(within(packs[0]!).getByRole('button'));

    const pay = await screen.findByTestId('confirm-pay');
    expect(pay).toBeDisabled();

    await user.click(screen.getByTestId('confirm-refund-ack'));
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
      await user.click(await screen.findByTestId('confirm-refund-ack'));
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

  it('lets the buyer try again when starting the checkout failed', async () => {
    const user = userEvent.setup();
    startCheckout.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('location', { assign: vi.fn(), href: 'https://app.test/s/mine' });
    try {
      renderBuy();
      const packs = await screen.findAllByTestId('credit-pack');
      await user.click(within(packs[0]!).getByRole('button'));
      await user.click(await screen.findByTestId('confirm-refund-ack'));
      const pay = screen.getByTestId('confirm-pay');
      await user.click(pay);

      await waitFor(() => {
        expect(startCheckout).toHaveBeenCalledTimes(1);
      });
      // The dialog is still the only place this purchase can be started
      // from, so the button has to come back rather than leaving the buyer
      // to work out that closing and reopening frees it.
      await waitFor(() => {
        expect(pay).toBeEnabled();
      });
      await user.click(pay);
      await waitFor(() => {
        expect(startCheckout).toHaveBeenCalledTimes(2);
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
      await user.click(await screen.findByTestId('confirm-refund-ack'));
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
    await user.click(await screen.findByTestId('confirm-refund-ack'));
    await user.keyboard('{Escape}');

    await user.click(within(packs[1]!).getByRole('button'));
    // The tick belongs to one purchase. Carried over to the next, it would
    // stand for a rule the buyer read about a different pack, and the pay
    // button would already be live on a dialog they have not looked at.
    expect(await screen.findByTestId('confirm-pay')).toBeDisabled();
  });
});
