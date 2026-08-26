// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 「购买记录」那一屏（任务 #13 §4.6）。
 *
 * 它列的是**付款**，所以一笔还没到账的、一笔弃单的都在这张表里 —— 那两种
 * 正是买家来这儿要问的。它们的积分包那一侧整排是 null，所以这一屏一半的
 * 断言是「哪几格这时候不该印数」。
 *
 * 重发只在确认邮件没发出去的行上出现，判据由服务端算成 `canResend` 送来：
 * `sending` 那个超时的值只有服务器读得到。
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
    const badge = await screen.findByTestId('purchase-status');
    expect(badge.textContent).toBeTruthy();
    expect(badge.textContent).not.toBe('');
  });

  it('puts all four states in the one list', async () => {
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
