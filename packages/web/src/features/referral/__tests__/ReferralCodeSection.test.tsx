// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { api, carry, toasts } = vi.hoisted(() => ({
  api: { get: vi.fn(), bind: vi.fn(), apply: vi.fn() },
  carry: { code: null as string | null, forget: vi.fn() },
  toasts: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@web/data/api/referral', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  referralApi: api,
}));
vi.mock('@web/lib/referral-carry', () => ({
  carriedReferralCode: () => carry.code,
  forgetCarriedReferralCode: carry.forget,
}));
vi.mock('@web/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/lib/toast')>();
  return { ...actual, toast: { ...actual.toast, ...toasts } };
});

import { ReferralCodeSection } from '@web/features/referral/ReferralCodeSection';
import { referralQueryKey } from '@web/features/referral/referral-query';
import { membershipQueryKey } from '@web/features/membership/membership-query';
import type { AccountReferral } from '@web/data/api/referral';
import { ApiException } from '@web/data/api/types';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { useCurrentUserStore } from '@web/stores';

const CAN_BIND: AccountReferral = {
  firstPeriodDiscountPercent: 20,
  binding: null,
  canBind: true,
  program: { open: false, termsVersion: '' },
  promoter: { state: 'none' },
};
const BOUND: AccountReferral = { ...CAN_BIND, canBind: false, binding: { code: 'ALICE', discountPending: true } };

let client: QueryClient;

/** Renders the section for user u1. */
function setup(): void {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ReferralCodeSection />
    </QueryClientProvider>,
  );
}

/**
 * A server refusal.
 * @param status - HTTP status.
 * @param reason - The refusal code.
 * @returns The exception the request layer throws.
 */
function refusal(status: number, reason?: string): ApiException {
  return new ApiException({ status, message: `refused ${reason ?? status}`, fromServer: true, reason });
}

beforeEach(() => {
  vi.clearAllMocks();
  carry.code = null;
  useCurrentUserStore.setState({ user: { id: 'u1' } as never, role: null, loading: false, bootstrapped: true });
});
afterEach(() => {
  resetRunOnceForTests();
});

describe('the referral code section (inner#1868 tables 12.9, 12.10)', () => {
  it('shows a skeleton on the first read', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    setup();
    expect(screen.getByTestId('referral-code-loading')).toBeInTheDocument();
  });

  it('shows a failed first read with a retry that reads again', async () => {
    api.get.mockRejectedValueOnce(refusal(500)).mockResolvedValueOnce(CAN_BIND);
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Referral code')).toBeInTheDocument();
  });

  it('draws nothing while payments are off', async () => {
    api.get.mockRejectedValue(refusal(404));
    setup();
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('referral-code-loading')).toBeNull());
    expect(screen.queryByText('Referral code')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('keeps showing the code when a background read fails', async () => {
    api.get.mockResolvedValueOnce(BOUND).mockRejectedValueOnce(refusal(500));
    setup();
    expect(await screen.findByText(/ALICE/)).toBeInTheDocument();
    await client.invalidateQueries({ queryKey: referralQueryKey('u1') });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/ALICE/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('pre-fills the carried code and binds it', async () => {
    carry.code = 'ALICE';
    api.get.mockResolvedValue(CAN_BIND);
    api.bind.mockResolvedValue(BOUND);
    const user = userEvent.setup();
    setup();
    expect(await screen.findByLabelText('Referral code')).toHaveValue('ALICE');
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText(/20% off your first membership period/)).toBeInTheDocument();
    expect(api.bind).toHaveBeenCalledWith('ALICE', expect.any(String));
    expect(toasts.success).toHaveBeenCalled();
    expect(carry.forget).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: membershipQueryKey('u1') }));
  });

  it('asks for a code instead of sending an empty one', async () => {
    api.get.mockResolvedValue(CAN_BIND);
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('button', { name: 'Add' }));
    expect(screen.getByText('Enter a referral code.')).toBeInTheDocument();
    expect(api.bind).not.toHaveBeenCalled();
  });

  it('shows an invalid code under the field and clears it on typing', async () => {
    api.get.mockResolvedValue(CAN_BIND);
    api.bind.mockRejectedValue(refusal(422, 'invalid_code'));
    const user = userEvent.setup();
    setup();
    await user.type(await screen.findByLabelText('Referral code'), 'NOPE');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('refused invalid_code')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Referral code'), 'X');
    expect(screen.queryByText('refused invalid_code')).toBeNull();
  });

  it('toasts a refusal about the account and reads the section again', async () => {
    api.get.mockResolvedValueOnce(CAN_BIND).mockResolvedValue({ ...CAN_BIND, canBind: false });
    api.bind.mockRejectedValue(refusal(422, 'already_paid'));
    const user = userEvent.setup();
    setup();
    await user.type(await screen.findByLabelText('Referral code'), 'ALICE');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('refused already_paid'));
    await waitFor(() => expect(screen.queryByLabelText('Referral code')).toBeNull());
  });

  it('keeps the typed code after a request that failed for good', async () => {
    api.get.mockResolvedValue(CAN_BIND);
    api.bind.mockRejectedValue(refusal(403));
    const user = userEvent.setup();
    setup();
    await user.type(await screen.findByLabelText('Referral code'), 'ALICE');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(screen.getByLabelText('Referral code')).toHaveValue('ALICE');
  });

  it('draws nothing once the first period has been paid', async () => {
    api.get.mockResolvedValue({ ...BOUND, binding: { code: 'ALICE', discountPending: false } });
    setup();
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('referral-code-loading')).toBeNull());
    expect(screen.queryByText(/ALICE/)).toBeNull();
  });
});
