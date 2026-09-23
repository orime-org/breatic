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
import { CREDIT_SOURCE_KINDS, isPurchased } from '@breatic/shared';
import type { PurchaseRow } from '@breatic/shared';
import en from '@locales/en.json';

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
    rowId: 'p1',
    sourceKind: 'payment' as PurchaseRow['sourceKind'],
    paymentId: 'p1' as string | null,
    amountCents: 2000 as number | null,
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

  it('names where granted credits came from, in the cell a price would fill', async () => {
    // Nobody paid, so there is no figure for that cell and no state a payment
    // could be in. What the reader cannot work out from the rest of the row is
    // where the credits came from, so that is what it says.
    history.mockResolvedValue({
      items: [
        row({
          rowId: 'lot-gift',
          sourceKind: 'gift',
          paymentId: null,
          amountCents: null,
          totalCents: null,
          taxCents: null,
          status: null,
          canResend: false,
        }),
      ],
      nextCursor: null,
    });
    renderHistory();
    const first = await screen.findByTestId('purchase-row');

    expect(first.textContent).toContain('Trial credits');
    expect(first.textContent).not.toContain('$');
    expect(within(first).queryByTestId('purchase-status')).toBeNull();
  });

  it.each(CREDIT_SOURCE_KINDS.filter((kind) => !isPurchased(kind)))(
    'names a %s row by the word the catalogue holds for it',
    async (kind) => {
      // The kinds come from the list itself and the words from the catalogue,
      // so a fifth kind added without a name to print fails on the lookup
      // instead of rendering the key.
      history.mockResolvedValue({
        items: [
          row({
            rowId: `lot-${kind}`,
            sourceKind: kind,
            paymentId: null,
            amountCents: null,
            totalCents: null,
            taxCents: null,
            status: null,
            canResend: false,
          }),
        ],
        nextCursor: null,
      });
      renderHistory();
      const first = await screen.findByTestId('purchase-row');

      expect(first.textContent).toContain(en.credits.source[kind]);
    },
  );

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
          designatedStudioId: null,
          designatedStudioName: null,
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
    // Nor may the third cell offer to point it somewhere: an abandoned
    // purchase has nothing to point.
    expect(first.textContent).not.toContain('Unassigned');
  });

  it('says the same about a purchase that failed', async () => {
    history.mockResolvedValue({
      items: [
        row({
          status: 'failed',
          totalCents: null,
          remainingCredits: null,
          lifecycle: null,
          designatedStudioId: null,
          designatedStudioName: null,
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

  it('prints the pre-tax price, labelled, while a purchase is in flight', async () => {
    history.mockResolvedValue({
      items: [
        row({
          status: 'pending',
          totalCents: null,
          remainingCredits: null,
          lifecycle: null,
        }),
      ],
      nextCursor: null,
    });
    renderHistory();
    const first = await screen.findByTestId('purchase-row');
    // Stripe cannot work the tax out before the buyer gives it an address, so
    // the final figure exists nowhere yet. The face value said plainly tells
    // them more than saying nothing does.
    expect(first.textContent).toContain('$20.00 before tax');
    expect(first.textContent).toContain('Shown once it lands');
    expect(first.textContent).not.toContain('Not charged');
  });

  it('says a purchase that ended was not charged, whatever figure it carries', async () => {
    history.mockResolvedValue({
      items: [
        // A delayed payment that was refused. Stripe had worked out a total
        // before the bank turned it down, so the row carries one — and not a
        // cent of it was taken.
        row({
          status: 'failed',
          amountCents: 2000,
          totalCents: 2240,
          taxCents: 240,
          remainingCredits: null,
          lifecycle: null,
          designatedStudioId: null,
          designatedStudioName: null,
        }),
      ],
      nextCursor: null,
    });
    renderHistory();
    const first = await screen.findByTestId('purchase-row');
    expect(first.textContent).toContain('Not charged');
    expect(first.textContent).not.toContain('22.40');
  });

  it('prints the final figure once Stripe has one, even before it lands', async () => {
    history.mockResolvedValue({
      items: [
        // A delayed payment method: the buyer typed their address and finished
        // the checkout, so Stripe has worked out the tax, while the money is
        // still clearing and no lot exists.
        row({
          status: 'pending',
          amountCents: 2000,
          totalCents: 2240,
          taxCents: 240,
          remainingCredits: null,
          lifecycle: null,
        }),
      ],
      nextCursor: null,
    });
    renderHistory();
    const first = await screen.findByTestId('purchase-row');
    expect(first.textContent).toContain('$22.40');
    expect(first.textContent).not.toContain('before tax');
  });

  it('does not offer to assign a purchase that has no lot behind it', async () => {
    history.mockResolvedValue({
      items: [
        row({
          status: 'pending',
          totalCents: null,
          remainingCredits: null,
          lifecycle: null,
          designatedStudioId: null,
          designatedStudioName: null,
        }),
      ],
      nextCursor: null,
    });
    renderHistory();
    const first = await screen.findByTestId('purchase-row');
    // "Unassigned" reads as something left to do, and there is nothing here to
    // do it to: the credits this purchase will grant do not exist yet.
    expect(first.textContent).not.toContain('Unassigned');
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

  it('tells a purchase pointed nowhere where to go, on its own row', async () => {
    history.mockResolvedValue({
      items: [
        // Active and pointed nowhere: the one row that carries the next step.
        row({ paymentId: 'a', designatedStudioId: null, designatedStudioName: null }),
        // Pointed nowhere but with no lot to point: nothing here to assign.
        // Drop the lifecycle half and this row would carry it too.
        row({
          paymentId: 'b',
          status: 'pending',
          lifecycle: null,
          designatedStudioId: null,
          designatedStudioName: null,
        }),
        // A lot, already pointed somewhere. Drop the designation half and this
        // row would carry it too.
        row({ paymentId: 'c' }),
      ],
      nextCursor: null,
    });
    renderHistory();
    const rows = await screen.findAllByTestId('purchase-row');
    const carrying = rows.filter((r) =>
      (r.textContent ?? '').includes('use Assign on the left'),
    );
    expect(carrying).toHaveLength(1);
    expect(carrying[0]?.textContent).toContain('Unassigned');
  });

  it('says a spent purchase is spent, wherever it points', async () => {
    history.mockResolvedValue({
      items: [
        // Spent and pointed nowhere. Assigning is about what is left to
        // spend, and there is none: the row says what became of it.
        row({
          paymentId: 'a',
          lifecycle: 'depleted',
          remainingCredits: 0,
          designatedStudioId: null,
          designatedStudioName: null,
        }),
        // Spent and still pointed somewhere: where the money went is the one
        // thing this row can still tell the buyer.
        row({ paymentId: 'b', lifecycle: 'depleted', remainingCredits: 0 }),
      ],
      nextCursor: null,
    });
    renderHistory();
    const rows = await screen.findAllByTestId('purchase-row');

    expect(rows[0]?.textContent).toContain('Used up');
    expect(rows[0]?.textContent).not.toContain('use Assign on the left');
    expect(rows[1]?.textContent).toContain('Assigned to Orime Studio');
    expect(rows[1]?.textContent).not.toContain('Used up');
  });

  it('says it on the row while another page is still coming', async () => {
    // The sentence belongs to the purchase, so it does not wait on a count of
    // the whole list the way a figure at the foot of the screen would.
    history.mockResolvedValue({
      items: [row({ designatedStudioId: null, designatedStudioName: null })],
      nextCursor: 'more',
    });
    renderHistory();
    const first = await screen.findByTestId('purchase-row');
    expect(first.textContent).toContain('use Assign on the left');
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
        row({ paymentId: 'a', canResend: false }),
        row({ paymentId: 'b', canResend: true }),
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
      items: [row({ paymentId: 'b', canResend: true })],
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

  it('stops offering it once the letter has gone, without another tap', async () => {
    const user = userEvent.setup();
    resendConfirmation.mockResolvedValue({ sent: true });
    history
      .mockResolvedValueOnce({
        items: [row({ canResend: true })],
        nextCursor: null,
      })
      .mockResolvedValue({ items: [row({ canResend: false })], nextCursor: null });
    renderHistory();

    await user.click(await screen.findByTestId('resend-confirmation'));
    await waitFor(() => {
      expect(resendConfirmation).toHaveBeenCalledTimes(1);
    });
    // The row is read again, so the control goes with the letter. Left as it
    // was, a second tap would be refused by the server and the buyer would be
    // told the letter did not go out.
    await waitFor(() => {
      expect(screen.queryByTestId('resend-confirmation')).toBeNull();
    });
  });

  it('says so when the letter still did not go out', async () => {
    const user = userEvent.setup();
    resendConfirmation.mockResolvedValue({ sent: false });
    history.mockResolvedValue({
      items: [row({ paymentId: 'b', canResend: true })],
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
