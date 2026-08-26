// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CreditOverview } from '@breatic/shared';

import { CreditsOverlay } from '@web/features/credits/CreditsOverlay';
import { useCurrentUserStore } from '@web/stores/current-user';

const fetchCreditOverview = vi.fn();
const fetchCreditLots = vi.fn();
const fetchCreditLedger = vi.fn();
vi.mock('@web/data/api/credits', () => ({
  fetchCreditOverview: () => fetchCreditOverview(),
  fetchCreditLots: (...args: unknown[]) => fetchCreditLots(...args),
  fetchCreditLedger: (...args: unknown[]) => fetchCreditLedger(...args),
  designateCreditLot: vi.fn(),
}));

const paymentHistory = vi.fn();
vi.mock('@web/data/api/payment', () => ({
  paymentApi: {
    tiers: () => Promise.resolve([]),
    history: (...args: unknown[]) => paymentHistory(...args),
    checkout: vi.fn(),
    resendConfirmation: vi.fn(),
  },
}));

vi.mock('@web/data/api/studios', () => ({
  studiosApi: { listUserStudios: () => Promise.resolve([]) },
}));

const ALEX = {
  id: 'u1',
  name: 'Alex',
  email: 'alex@x.example',
  personalStudio: { name: 'Alex', slug: 'alex', avatarUrl: null },
  membershipTier: 'base' as const,
};

/**
 * An overview with nothing in it, which is what most of these tests need —
 * they ask about the index, not about the figures.
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
 * Render the overlay, open.
 * @returns The render result.
 */
function setup(): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CreditsOverlay open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('CreditsOverlay', () => {
  beforeEach(() => {
    useCurrentUserStore.getState().clear();
    useCurrentUserStore.getState().setUser(ALEX);
    fetchCreditOverview.mockReset().mockResolvedValue(overview());
    fetchCreditLots
      .mockReset()
      .mockResolvedValue({ items: [], nextCursor: null });
    fetchCreditLedger
      .mockReset()
      .mockResolvedValue({ items: [], nextCursor: null });
  });

  it('lists seven entries in two groups, in a fixed order', async () => {
    setup();

    const index = await screen.findByTestId('credits-index');
    const tabs = index.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(7);
    // The order is the product's: the four that answer a question, then the
    // three that change something.
    expect([...tabs].map((tab) => tab.id)).toEqual([
      'credits-tab-overview',
      'credits-tab-lots',
      'credits-tab-ledger',
      'credits-tab-studios',
      'credits-tab-buy',
      'credits-tab-assign',
      'credits-tab-refunds',
    ]);
  });

  it('opens on the overview', async () => {
    setup();

    const first = await screen.findByRole('tab', { name: /Overview/ });
    expect(first).toHaveAttribute('aria-selected', 'true');
    // Only the selected entry is in the tab order; otherwise leaving the
    // index takes seven presses.
    expect(first).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: /Purchases/ })).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });

  it('switches on a click and reads only what that entry needs', async () => {
    const user = userEvent.setup();
    setup();

    await screen.findByTestId('credits-index');
    // The overview reads no paged endpoint.
    expect(paymentHistory).not.toHaveBeenCalled();

    await user.click(screen.getByRole('tab', { name: /Purchases/ }));

    await waitFor(() => {
      expect(paymentHistory).toHaveBeenCalled();
    });
    expect(screen.getByRole('tab', { name: /Purchases/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Having moved, it is no longer on the overview.
    expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('walks the index with the arrow keys and wraps at both ends', async () => {
    const user = userEvent.setup();
    setup();

    const first = await screen.findByRole('tab', { name: /Overview/ });
    first.focus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('tab', { name: /Purchases/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // Up from the first entry reaches the last, rather than staying put.
    screen.getByRole('tab', { name: /Overview/ }).focus();
    await user.click(screen.getByRole('tab', { name: /Overview/ }));
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('tab', { name: /Refunds/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('jumps to the last entry with End and back with Home', async () => {
    const user = userEvent.setup();
    setup();

    const first = await screen.findByRole('tab', { name: /Overview/ });
    first.focus();

    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: /Refunds/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('gives buying a cart, apart from the star the menu uses', async () => {
    // The menu entry and the top bar's balance pill are the same star. This
    // entry taking it too would make the three read as one thing.
    setup();

    const buy = await screen.findByRole('tab', { name: /Buy credits/ });
    expect(buy.querySelector('.lucide-shopping-cart')).not.toBeNull();
    expect(buy.querySelector('.lucide-star')).toBeNull();
  });

  it('says so when the overview cannot be read, rather than showing nothing', async () => {
    fetchCreditOverview.mockRejectedValue(new Error('nope'));
    setup();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('scrolls inside one Scroller, with no bare overflow in the panel', async () => {
    setup();

    const body = await screen.findByRole('tabpanel');
    // Radix's viewport is the element that actually scrolls.
    expect(body.closest('[data-radix-scroll-area-viewport]')).not.toBeNull();

    // No second kind of scroll container: a bare overflow leaves the bar to
    // the browser, and every engine draws its own.
    const dialog = screen.getByRole('dialog');
    const bare = [...dialog.querySelectorAll('*')].filter((el) => {
      if (el.hasAttribute('data-radix-scroll-area-viewport')) return false;
      const cls = el.className;
      return typeof cls === 'string' && /overflow-(y-|x-)?(auto|scroll)/.test(cls);
    });
    expect(bare).toEqual([]);
  });
});
