// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The studio's single transfer entry, and what it becomes while an offer waits.
 *
 * A studio has one admin, so it can hold only one outstanding offer. Leaving
 * the picker up while one is pending offers a dead end — sending again just
 * answers 409 — and worse, hides the only way to redirect the offer to someone
 * else before it times out a week later.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@web/data/api/studios', () => ({
  studiosApi: {
    requestTransfer: vi.fn(),
    liveTransfer: vi.fn(),
    withdrawTransfer: vi.fn(),
  },
}));

import { TransferStudioSection } from '@web/pages/studio/container/tabs/settings/TransferStudioSection';
import { studiosApi } from '@web/data/api/studios';
import type { StudioMember } from '@web/pages/studio/container/container-types';

const SLUG = 'acme';
const TRANSFER = 't-1';

const MEMBERS = [
  {
    id: 'u-admin',
    name: 'Ada Admin',
    email: 'ada@e.com',
    studioRole: 'admin',
  },
  {
    id: 'u-maint',
    name: 'Mo Maintainer',
    email: 'mo@e.com',
    studioRole: 'maintainer',
  },
] as unknown as readonly StudioMember[];

/**
 * Render inside a fresh QueryClientProvider — the section reads the studio's
 * live offer and invalidates that read after sending or withdrawing.
 * @param ui - The element under test.
 * @returns The render result.
 */
function renderSection(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

/**
 * A live offer to the maintainer, expiring a week out.
 * @returns The offer shape the section reads.
 */
function liveOffer() {
  return {
    id: TRANSFER,
    fromUserId: 'u-admin',
    toUserId: 'u-maint',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

describe('TransferStudioSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(studiosApi.liveTransfer).mockResolvedValue(null);
  });

  it('offers the picker when nothing is outstanding', async () => {
    renderSection(<TransferStudioSection slug={SLUG} members={MEMBERS} />);
    expect(
      await screen.findByTestId('settings-transfer-open'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('settings-transfer-pending'),
    ).not.toBeInTheDocument();
  });

  it('becomes the offer’s status while one waits', async () => {
    vi.mocked(studiosApi.liveTransfer).mockResolvedValue(liveOffer());
    renderSection(<TransferStudioSection slug={SLUG} members={MEMBERS} />);

    const pending = await screen.findByTestId('settings-transfer-pending');
    // Naming the recipient is the point: the admin has to be able to tell who
    // they are waiting on before deciding whether to withdraw.
    expect(pending).toHaveTextContent('Mo Maintainer');
    expect(screen.getByTestId('settings-transfer-expiry')).toHaveTextContent(
      /7/,
    );
    expect(
      screen.queryByTestId('settings-transfer-open'),
    ).not.toBeInTheDocument();
  });

  it('withdraws the offer it is showing', async () => {
    vi.mocked(studiosApi.liveTransfer).mockResolvedValue(liveOffer());
    vi.mocked(studiosApi.withdrawTransfer).mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderSection(<TransferStudioSection slug={SLUG} members={MEMBERS} />);
    await user.click(await screen.findByTestId('settings-transfer-withdraw'));

    await waitFor(() => {
      expect(studiosApi.withdrawTransfer).toHaveBeenCalledWith(SLUG, TRANSFER);
    });
  });

  /**
   * A request whose answer the case decides.
   * @param succeeds - Whether it resolves or rejects.
   * @returns The pending promise and the function that settles it.
   */
  function deferred(succeeds: boolean): { promise: Promise<{ ok: true }>; settle: () => void } {
    let settle: () => void = () => {};
    const promise = new Promise<{ ok: true }>((resolve, reject) => {
      settle = succeeds ? () => resolve({ ok: true }) : () => reject(new Error('nope'));
    });
    return { promise, settle };
  }

  it.each([
    ['succeeds', true],
    ['fails', false],
  ])('marks Withdraw busy while the withdraw is out, and clears it once it %s', async (_label, succeeds) => {
    vi.mocked(studiosApi.liveTransfer).mockResolvedValue(liveOffer());
    const request = deferred(succeeds);
    vi.mocked(studiosApi.withdrawTransfer).mockReturnValue(request.promise);
    const user = userEvent.setup();
    renderSection(<TransferStudioSection slug={SLUG} members={MEMBERS} />);
    const withdraw = await screen.findByTestId('settings-transfer-withdraw');
    await user.click(withdraw);

    await waitFor(() => expect(withdraw).toHaveAttribute('aria-busy', 'true'));
    expect(withdraw).toHaveAttribute('aria-disabled', 'true');

    request.settle();
    await waitFor(() => expect(withdraw).not.toHaveAttribute('aria-busy'));
  });

  /**
   * Pick the maintainer and press Send, with the request held open.
   * @param succeeds - Whether the held request resolves or rejects.
   * @returns The Send button and the function that answers the request.
   */
  async function sendHeld(succeeds: boolean): Promise<{ send: HTMLElement; settle: () => void }> {
    const request = deferred(succeeds);
    vi.mocked(studiosApi.requestTransfer).mockReturnValue(request.promise);
    const user = userEvent.setup();
    renderSection(<TransferStudioSection slug={SLUG} members={MEMBERS} />);
    await user.click(await screen.findByTestId('settings-transfer-open'));
    await user.click(await screen.findByTestId('settings-transfer-select'));
    await user.click(await screen.findByText(/Mo Maintainer/));
    const send = screen.getByTestId('settings-transfer-send');
    await user.click(send);
    await waitFor(() => expect(send).toHaveAttribute('aria-busy', 'true'));
    expect(send).toHaveAttribute('aria-disabled', 'true');
    return { send, settle: request.settle };
  }

  it('marks Send busy while the offer is out, and closes the picker once it is sent', async () => {
    const { settle } = await sendHeld(true);
    settle();
    await waitFor(() =>
      expect(screen.queryByTestId('settings-transfer-dialog')).toBeNull(),
    );
  });

  it('marks Send busy while the offer is out, and clears it when the offer is refused', async () => {
    const { send, settle } = await sendHeld(false);
    settle();
    await waitFor(() => expect(send).not.toHaveAttribute('aria-busy'));
    expect(screen.getByTestId('settings-transfer-dialog')).toBeInTheDocument();
  });
});
