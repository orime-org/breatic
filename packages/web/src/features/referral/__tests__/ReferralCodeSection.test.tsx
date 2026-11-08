// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { api, carry, toasts } = vi.hoisted(() => ({
  api: { get: vi.fn(), bind: vi.fn(), apply: vi.fn() },
  carry: { code: null as string | null, forget: vi.fn(), refused: vi.fn() },
  toasts: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@web/data/api/referral', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  referralApi: api,
}));
vi.mock('@web/lib/referral-carry', () => ({
  carriedReferralCode: () => carry.code,
  forgetCarriedReferralCode: carry.forget,
  forgetRefusedReferralCode: carry.refused,
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
import { getReferralForms, resetReferralFormsForTests } from '@web/stores/referral-forms';
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
 * Renders the section over the same client, as reopening the panel does.
 * @returns The render handle.
 */
function renderSection(): ReturnType<typeof render> {
  return render(
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
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useCurrentUserStore.setState({ user: { id: 'u1' } as never, role: null, loading: false, bootstrapped: true });
});
afterEach(() => {
  resetRunOnceForTests();
  resetReferralFormsForTests();
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
    expect(screen.getByLabelText('Referral code')).toHaveAttribute('maxLength', '40');
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText(/20% off your first membership period/)).toBeInTheDocument();
    expect(api.bind).toHaveBeenCalledWith('ALICE', expect.any(String));
    expect(toasts.success).toHaveBeenCalled();
    expect(carry.forget).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: membershipQueryKey('u1') }));
    expect(getReferralForms().bind).toEqual({ value: null, error: null });
  });

  it('locks the field while the code is being sent', async () => {
    api.get.mockResolvedValue(CAN_BIND);
    api.bind.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    setup();
    await user.type(await screen.findByLabelText('Referral code'), 'ALICE');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.getByLabelText('Referral code')).toHaveAttribute('readonly'));
  });

  it('shows the code being sent after the panel is closed and opened again, and the refusal under it', async () => {
    carry.code = 'ABC';
    api.get.mockResolvedValue(CAN_BIND);
    let refuse: (err: unknown) => void = () => undefined;
    api.bind.mockReturnValue(new Promise((_, reject) => { refuse = reject; }));
    const user = userEvent.setup();
    const first = renderSection();
    const field = await screen.findByLabelText('Referral code');
    await user.clear(field);
    await user.type(field, 'XYZ');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.bind).toHaveBeenCalled());
    first.unmount();

    renderSection();
    expect(await screen.findByLabelText('Referral code')).toHaveValue('XYZ');
    expect(screen.getByLabelText('Referral code')).toHaveAttribute('readonly');

    await act(async () => { refuse(refusal(422, 'invalid_code')); });
    expect(await screen.findByText('refused invalid_code')).toBeInTheDocument();
    expect(screen.getByLabelText('Referral code')).toHaveValue('XYZ');
    expect(screen.getByLabelText('Referral code')).not.toHaveAttribute('readonly');
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it('toasts a refusal that arrives while the panel is closed, and shows it under the field on reopening', async () => {
    api.get.mockResolvedValue(CAN_BIND);
    let refuse: (err: unknown) => void = () => undefined;
    api.bind.mockReturnValue(new Promise((_, reject) => { refuse = reject; }));
    const user = userEvent.setup();
    const first = renderSection();
    await user.type(await screen.findByLabelText('Referral code'), 'XYZ');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.bind).toHaveBeenCalled());
    first.unmount();

    await act(async () => { refuse(refusal(422, 'invalid_code')); });
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('refused invalid_code'));

    renderSection();
    expect(await screen.findByLabelText('Referral code')).toHaveValue('XYZ');
    expect(screen.getByText('refused invalid_code')).toBeInTheDocument();
  });

  it('keeps the code that was sent when a reopened panel gets another final refusal', async () => {
    carry.code = 'ABC';
    api.get.mockResolvedValue(CAN_BIND);
    let refuse: (err: unknown) => void = () => undefined;
    api.bind.mockReturnValue(new Promise((_, reject) => { refuse = reject; }));
    const user = userEvent.setup();
    const first = renderSection();
    const field = await screen.findByLabelText('Referral code');
    await user.clear(field);
    await user.type(field, 'XYZ');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.bind).toHaveBeenCalled());
    first.unmount();

    renderSection();
    await screen.findByLabelText('Referral code');
    await act(async () => { refuse(refusal(403)); });
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('refused 403'));
    expect(screen.getByLabelText('Referral code')).toHaveValue('XYZ');
  });

  it('keeps a typed code across closing and reopening the panel', async () => {
    carry.code = 'ABC';
    api.get.mockResolvedValue(CAN_BIND);
    const user = userEvent.setup();
    const first = renderSection();
    const field = await screen.findByLabelText('Referral code');
    await user.clear(field);
    await user.type(field, 'XYZ');
    first.unmount();

    renderSection();
    expect(await screen.findByLabelText('Referral code')).toHaveValue('XYZ');
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
    expect(carry.refused).toHaveBeenCalledWith('NOPE');
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

  it('sends the press again with the same key after a throttle, and binds', async () => {
    // A throttled press has no answer yet, so it keeps waiting rather than failing (packages/web/AGENTS.md#waiting-buttons-show-loading).
    api.get.mockResolvedValue(CAN_BIND);
    api.bind
      .mockRejectedValueOnce(new ApiException({ status: 429, message: 'slow down', fromServer: true, retryAfterSeconds: 0 }))
      .mockResolvedValueOnce(BOUND);
    const user = userEvent.setup();
    setup();
    await user.type(await screen.findByLabelText('Referral code'), 'ALICE');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    expect(api.bind).toHaveBeenCalledTimes(2);
    expect(api.bind.mock.calls[1]![1]).toBe(api.bind.mock.calls[0]![1]);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it('draws nothing once the first period has been paid', async () => {
    api.get.mockResolvedValue({ ...BOUND, binding: { code: 'ALICE', discountPending: false } });
    setup();
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('referral-code-loading')).toBeNull());
    expect(screen.queryByText(/ALICE/)).toBeNull();
  });
});
