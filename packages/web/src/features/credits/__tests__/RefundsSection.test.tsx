// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Asking for a refund: the confirmation stays open, with its confirm button
 * spinning, until the server answers and, on success, until the account reads
 * it changed are back. A success then closes it; a refusal leaves it
 * open so the buyer can read the toast and try again from where they were.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CreditLotView } from '@breatic/shared';
import en from '@locales/en.json';

import { RefundsSection } from '@web/features/credits/sections/RefundsSection';

const fetchCreditLots = vi.fn();
const requestCreditLotRefund = vi.fn();
vi.mock('@web/data/api/credits', () => ({
  fetchCreditLots: (...args: unknown[]) => fetchCreditLots(...args),
  requestCreditLotRefund: (...args: unknown[]) => requestCreditLotRefund(...args),
}));

vi.mock('@web/data/api/payment', () => ({
  paymentApi: {
    tiers: () =>
      Promise.resolve({
        packs: [],
        confirmTimeoutMs: 15000,
        refundLines: [],
        consentText: '',
      }),
  },
}));

const toastError = vi.fn();
vi.mock('@web/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: (...a: unknown[]) => toastError(...a),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@web/lib/use-scrolled-to-end', () => ({
  useScrolledToEnd: () => ({ scrollerRef: () => {}, sentinelRef: () => {} }),
}));

/**
 * A purchase the server would accept an ask about.
 * @returns The lot.
 */
function refundableLot(): CreditLotView {
  return {
    id: 'lot-1',
    sourceKind: 'payment' as CreditLotView['sourceKind'],
    purchasedCredits: 1700,
    remainingCredits: 1700,
    designatedStudioId: null,
    designatedStudioName: null,
    designated: false,
    paidCents: 2240,
    currency: 'usd',
    lifecycle: 'active',
    refundAttempts: 0,
    everSpent: false,
    everRestored: false,
    createdAt: new Date().toISOString(),
  };
}

/** The two ways a pending ask can end. */
interface Settle {
  resolve: () => void;
  reject: (reason: Error) => void;
}

/**
 * Hold the next ask open until the test settles it.
 * @returns The handles that settle it.
 */
function deferAsk(): Settle {
  const settle: Settle = { resolve: () => undefined, reject: () => undefined };
  requestCreditLotRefund.mockReturnValue(
    new Promise<void>((resolve, reject) => {
      settle.resolve = resolve;
      settle.reject = reject;
    }),
  );
  return settle;
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchCreditLots.mockResolvedValue({ items: [refundableLot()], nextCursor: null });
});

/**
 * Render the refunds list.
 * @returns The render result.
 */
function renderRefunds(): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RefundsSection userId='u1' billing />
    </QueryClientProvider>,
  );
}

/**
 * Open the confirmation and press its confirm button.
 * @param user - The driving user.
 * @returns The dialog and its confirm button.
 */
async function confirmAsk(
  user: ReturnType<typeof userEvent.setup>,
): Promise<{ dialog: HTMLElement; confirm: HTMLElement }> {
  await user.click(
    await screen.findByRole('button', { name: en.credits.askRefund }),
  );
  const dialog = await screen.findByRole('alertdialog');
  const confirm = within(dialog).getByRole('button', {
    name: en.credits.confirmRefund.confirm,
  });
  await user.click(confirm);
  return { dialog, confirm };
}

describe('asking for a refund', () => {
  it('keeps the confirmation open and spinning until the server agrees, then closes it', async () => {
    const user = userEvent.setup();
    const settle = deferAsk();
    renderRefunds();
    const { dialog, confirm } = await confirmAsk(user);

    await waitFor(() => {
      expect(confirm).toHaveAttribute('aria-busy', 'true');
    });
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    expect(dialog).toBeInTheDocument();
    expect(requestCreditLotRefund).toHaveBeenCalledWith('lot-1');

    settle.resolve();
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });

  it('leaves the confirmation open, no longer spinning, when the server refuses', async () => {
    const user = userEvent.setup();
    const settle = deferAsk();
    renderRefunds();
    const { confirm } = await confirmAsk(user);

    await waitFor(() => {
      expect(confirm).toHaveAttribute('aria-busy', 'true');
    });

    settle.reject(new Error('offline'));
    await waitFor(() => {
      expect(toastError).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(confirm).not.toHaveAttribute('aria-busy');
    });
    expect(confirm).not.toHaveAttribute('aria-disabled');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});

describe('a purchase whose credits were restored (inner#1410 v9 §5.3)', () => {
  // The buyer took the credits back instead of the money after Stripe could
  // not refund the card: the row says so and carries no ask, the same answer
  // the server gives (409 server.credit.refund_restored).
  const restoredNote = (en.credits.refundReason as Record<string, string>)['restored'];

  it('the catalog has the sentence', () => {
    expect(typeof restoredNote).toBe('string');
    expect(restoredNote).not.toBe('');
  });

  it('shows credits.refundReason.restored in place of the ask button', async () => {
    fetchCreditLots.mockResolvedValue({
      items: [{ ...refundableLot(), id: 'lot-r', everRestored: true }],
      nextCursor: null,
    });
    renderRefunds();

    await screen.findByTestId('lot-remaining');
    expect(screen.getByText(restoredNote!)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.credits.askRefund })).toBeNull();
  });
});
