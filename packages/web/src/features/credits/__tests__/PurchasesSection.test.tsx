// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The purchase history screen (task #13 §4.6).
 *
 * What it lists is *payments*, so a purchase that has not landed yet and one
 * that was abandoned both show up in this table - and those two are exactly
 * what a buyer comes here to ask about. For those rows the whole credit-lot
 * side is null, which is why half the assertions here are about which cells
 * must print no figure at this point.
 *
 * Resending only appears on rows whose confirmation mail did not go out. That
 * call is made on the server and arrives as `canResend`: the timeout that
 * decides when a still-`sending` mail counts as stuck is only readable there.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PurchaseRow } from '@breatic/shared';

import { PurchasesSection } from '@web/features/credits/sections/PurchasesSection';

const history = vi.fn();
const resendConfirmation = vi.fn();
vi.mock('@web/data/api/payment', () => ({
  paymentApi: {
    history: (...args: unknown[]) => history(...args),
    resendConfirmation: (...args: unknown[]) => resendConfirmation(...args),
  },
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('@web/lib/toast', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@web/lib/use-scrolled-to-end', () => ({
  useScrolledToEnd: () => ({ scrollerRef: () => {}, sentinelRef: () => {} }),
}));

/**
 * One row, landed unless told otherwise.
 * @param over - Fields to override.
 * @returns The row.
 */
function row(over: Partial<PurchaseRow> = {}): PurchaseRow {
  return {
    paymentId: 'p1',
    amountCents: 2000,
    totalCents: 2240,
    taxCents: 240,
    currency: 'usd',
    creditsGranted: 1700,
    remainingCredits: 1700,
    lifecycle: 'active',
    designatedStudioId: 's1',
    designatedStudioName: 'Orime Studio',
    status: 'completed',
    createdAt: '2026-08-25T10:00:00.000Z',
    mailStatus: 'sent',
    canResend: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  history.mockResolvedValue({ items: [row()], nextCursor: null });
  resendConfirmation.mockResolvedValue({ sent: true });
});

/**
 * Render the purchase history.
 * @param billing - Whether this deployment charges at all.
 * @returns The render result.
 */
function renderHistory(billing = true): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PurchasesSection userId='u1' billing={billing} />
    </QueryClientProvider>,
  );
}

describe('the purchase history', () => {
  it('gives a landed purchase what was charged, what landed, and where it points', async () => {
    renderHistory();
    const first = await screen.findByTestId('purchase-row');
    // What the card was charged, tax included — this is the figure a buyer
    // matches against their statement.
    expect(first.textContent).toContain('$22.40');
    expect(first.textContent).toContain('1,700');
    expect(first.textContent).toContain('Orime Studio');
  });

  it('shows a purchase still processing, with no figures it does not have yet', async () => {
    history.mockResolvedValue({
      items: [
        row({
          status: 'pending',
          totalCents: null,
          taxCents: null,
          remainingCredits: null,
          lifecycle: null,
          designatedStudioId: null,
          designatedStudioName: null,
          mailStatus: null,
        }),
      ],
      nextCursor: null,
    });
    renderHistory();
    const first = await screen.findByTestId('purchase-row');

    expect(within(first).getByTestId('purchase-status')).toBeInTheDocument();
    // The listed price is known; what was actually charged is not, and
    // printing the pre-tax figure as though it were would misstate it.
    expect(first.textContent).not.toContain('$22.40');
    expect(within(first).queryByTestId('purchase-remaining')).toBeNull();
  });

  it('shows an abandoned purchase as over rather than in flight', async () => {
    history.mockResolvedValue({
      items: [
        row({
          status: 'expired',
          totalCents: null,
          remainingCredits: null,
          lifecycle: null,
          mailStatus: null,
        }),
      ],
      nextCursor: null,
    });
    renderHistory();
    const first = await screen.findByTestId('purchase-row');
    expect(within(first).getByTestId('purchase-status').textContent).toBe(
      'Expired',
    );
    // Nothing about this purchase is still coming, so neither cell may say it
    // is. The card was never charged and no credits will arrive.
    expect(first.textContent).toContain('Not charged');
    expect(first.textContent).not.toContain('Charged at checkout');
    expect(first.textContent).not.toContain('Shown once it lands');
  });

  it('says the same about a purchase that failed', async () => {
    history.mockResolvedValue({
      items: [
        row({
          status: 'failed',
          totalCents: null,
          remainingCredits: null,
          lifecycle: null,
          mailStatus: null,
        }),
      ],
      nextCursor: null,
    });
    renderHistory();
    const first = await screen.findByTestId('purchase-row');
    expect(within(first).getByTestId('purchase-status').textContent).toBe(
      'Failed',
    );
    expect(first.textContent).toContain('Not charged');
    expect(first.textContent).not.toContain('Shown once it lands');
  });

  it('still says a purchase in flight has both of those coming', async () => {
    history.mockResolvedValue({
      items: [
        row({
          status: 'pending',
          totalCents: null,
          remainingCredits: null,
          lifecycle: null,
          mailStatus: null,
        }),
      ],
      nextCursor: null,
    });
    renderHistory();
    const first = await screen.findByTestId('purchase-row');
    expect(first.textContent).toContain('Charged at checkout');
    expect(first.textContent).toContain('Shown once it lands');
    expect(first.textContent).not.toContain('Not charged');
  });

  it('puts all four states in the one list, each saying which it is', async () => {
    history.mockResolvedValue({
      items: [
        row({ paymentId: 'a', status: 'completed' }),
        row({ paymentId: 'b', status: 'pending', totalCents: null }),
        row({ paymentId: 'c', status: 'expired', totalCents: null }),
        row({ paymentId: 'd', status: 'failed', totalCents: null }),
      ],
      nextCursor: null,
    });
    renderHistory();
    await waitFor(() => {
      expect(screen.getAllByTestId('purchase-row')).toHaveLength(4);
    });
    // Every row carries a badge, including the one that landed: a reader
    // scanning the column should not have to work out that a blank means it
    // went through.
    const badges = screen.getAllByTestId('purchase-status');
    expect(badges.map((b) => b.textContent)).toEqual([
      'Landed',
      'Processing',
      'Expired',
      'Failed',
    ]);
  });

  it('counts what still needs assigning, and only once the list is read through', async () => {
    history.mockResolvedValue({
      items: [
        row({ paymentId: 'a', designatedStudioId: null, designatedStudioName: null }),
        row({ paymentId: 'b', status: 'pending', lifecycle: null }),
      ],
      nextCursor: null,
    });
    renderHistory();
    await screen.findAllByTestId('purchase-row');
    // One active-and-unassigned; the pending row has no lot and is not one.
    expect(await screen.findByTestId('unassigned-notice')).toBeInTheDocument();
  });

  it('says nothing about assigning while another page is still coming', async () => {
    history.mockResolvedValue({
      items: [row({ designatedStudioId: null, designatedStudioName: null })],
      nextCursor: 'more',
    });
    renderHistory();
    await screen.findByTestId('purchase-row');
    // A figure that climbs as you scroll says less than none.
    expect(screen.queryByTestId('unassigned-notice')).toBeNull();
  });

  it('offers nothing where this deployment sells nothing', async () => {
    renderHistory(false);
    await waitFor(() => {
      expect(screen.queryAllByTestId('purchase-row')).toHaveLength(0);
    });
    expect(history).not.toHaveBeenCalled();
  });

  it('says the list is empty when it is', async () => {
    history.mockResolvedValue({ items: [], nextCursor: null });
    renderHistory();
    expect(await screen.findByTestId('credits-empty')).toBeInTheDocument();
  });
});

describe('sending the confirmation again', () => {
  it('offers it only where the server says the letter did not go out', async () => {
    history.mockResolvedValue({
      items: [
        row({ paymentId: 'a', mailStatus: 'sent', canResend: false }),
        row({ paymentId: 'b', mailStatus: 'failed', canResend: true }),
      ],
      nextCursor: null,
    });
    renderHistory();
    await waitFor(() => {
      expect(screen.getAllByTestId('purchase-row')).toHaveLength(2);
    });
    expect(screen.getAllByTestId('resend-confirmation')).toHaveLength(1);
  });

  it('sends it for the row it was tapped on', async () => {
    const user = userEvent.setup();
    history.mockResolvedValue({
      items: [row({ paymentId: 'b', mailStatus: 'failed', canResend: true })],
      nextCursor: null,
    });
    renderHistory();
    await user.click(await screen.findByTestId('resend-confirmation'));

    await waitFor(() => {
      expect(resendConfirmation).toHaveBeenCalledWith('b');
    });
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalled();
    });
  });

  it('says so when the letter still did not go out', async () => {
    const user = userEvent.setup();
    resendConfirmation.mockResolvedValue({ sent: false });
    history.mockResolvedValue({
      items: [row({ paymentId: 'b', mailStatus: 'skipped', canResend: true })],
      nextCursor: null,
    });
    renderHistory();
    await user.click(await screen.findByTestId('resend-confirmation'));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalled();
    });
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
