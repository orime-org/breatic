// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type * as AuthModule from '@web/data/api/auth';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { carry, warning } = vi.hoisted(() => ({
  carry: { code: null as string | null, forget: vi.fn(), refused: vi.fn() },
  warning: vi.fn(),
}));

vi.mock('@web/data/api/auth', async () => {
  const actual = await vi.importActual<typeof AuthModule>('@web/data/api/auth');
  return {
    ...actual,
    authApi: { ...actual.authApi, options: vi.fn(), register: vi.fn(), verifySignupCode: vi.fn(), resendSignupCode: vi.fn(), google: vi.fn() },
  };
});
vi.mock('@web/lib/referral-carry', () => ({
  carriedReferralCode: () => carry.code,
  forgetCarriedReferralCode: carry.forget,
  forgetRefusedReferralCode: carry.refused,
}));
vi.mock('@web/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/lib/toast')>();
  return { ...actual, toast: { ...actual.toast, warning } };
});

vi.mock('@web/pages/auth/GoogleSignIn', () => ({
  GoogleSignIn: ({ busy, onCredential }: { busy: boolean; onCredential: (c: string) => Promise<void> }) => (
    <button type='button' disabled={busy} onClick={() => void onCredential('credential')}>
      Continue with Google
    </button>
  ),
}));

import RegisterPage from '@web/pages/auth/RegisterPage';
import { authApi } from '@web/data/api/auth';
import { ApiException } from '@web/data/api/types';
import { useCurrentUserStore } from '@web/stores';

const USER = { id: 'u1', email: 'foo@bar.com', personalStudio: null, membershipTier: 'base', locale: 'en' } as const;

/** Renders the sign-up page with the routes it can leave for. */
function setup(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/register']}>
        <Routes>
          <Route path='/register' element={<RegisterPage />} />
          <Route path='/recovery-code' element={<div data-testid='recovery-page' />} />
          <Route path='/choose-slug' element={<div data-testid='onboarding-page' />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Fills email and password and presses Create account.
 * @param user - The user-event instance.
 */
async function submit(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText('Email'), 'foo@bar.com');
  await user.type(screen.getByLabelText('Password'), 'supersecret');
  await user.click(screen.getByRole('button', { name: 'Create account' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  carry.code = null;
  useCurrentUserStore.setState({ user: null, role: null, loading: false, bootstrapped: true });
  vi.mocked(authApi.options).mockResolvedValue({ emailVerification: false, referralEnabled: true });
});

describe('the sign-up page referral field (inner#1868 table 12.13)', () => {
  it('shows a placeholder and keeps Create account waiting while the options load', () => {
    vi.mocked(authApi.options).mockReturnValue(new Promise(() => {}));
    setup();
    expect(screen.getByTestId('register-referral-loading')).toBeInTheDocument();
    expect(screen.queryByLabelText('Referral code')).toBeNull();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled();
  });

  it('has no field and sends no code while payments are off', async () => {
    carry.code = 'ALICE';
    vi.mocked(authApi.options).mockResolvedValue({ emailVerification: false, referralEnabled: false });
    vi.mocked(authApi.register).mockResolvedValue({ status: 'created', user: USER, recoveryCode: 'AAAA-BBBB-CCCC-DDDD' } as never);
    const user = userEvent.setup();
    setup();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled());
    expect(screen.queryByLabelText('Referral code')).toBeNull();
    await submit(user);
    expect(vi.mocked(authApi.register).mock.calls[0]![0]).not.toHaveProperty('referralCode');
  });

  it('pre-fills the code from the share link and sends it as from the link', async () => {
    carry.code = 'ALICE';
    vi.mocked(authApi.register).mockResolvedValue({ status: 'created', user: USER, recoveryCode: 'AAAA-BBBB-CCCC-DDDD' } as never);
    const user = userEvent.setup();
    setup();
    expect(await screen.findByLabelText('Referral code')).toHaveValue('ALICE');
    // The API takes at most 40 characters; longer text could not reach the field's own refusal.
    expect(screen.getByLabelText('Referral code')).toHaveAttribute('maxLength', '40');
    await submit(user);
    expect(authApi.register).toHaveBeenCalledWith(expect.objectContaining({ referralCode: 'ALICE', referralSource: 'signup_link' }));
    expect(await screen.findByTestId('recovery-page')).toBeInTheDocument();
    expect(carry.forget).toHaveBeenCalled();
  });

  it('shows a refused code under the field, stays on the page and names the refused code to the carried one', async () => {
    carry.code = 'ALICE';
    vi.mocked(authApi.register).mockRejectedValue(
      new ApiException({ status: 422, message: 'This referral code is not valid.', fromServer: true, reason: 'invalid_code' }),
    );
    const user = userEvent.setup();
    setup();
    await screen.findByLabelText('Referral code');
    await submit(user);
    expect(await screen.findByText('This referral code is not valid.')).toBeInTheDocument();
    expect(screen.getByLabelText('Referral code')).toHaveAttribute('aria-invalid', 'true');
    expect(carry.refused).toHaveBeenCalledWith('ALICE');
    expect(screen.queryByTestId('recovery-page')).toBeNull();
  });

  it('warns that the code was not used when step two reports it, then goes on', async () => {
    carry.code = 'ALICE';
    vi.mocked(authApi.options).mockResolvedValue({ emailVerification: true, referralEnabled: true });
    vi.mocked(authApi.register).mockResolvedValue({ status: 'code_sent', expiresInSeconds: 600, resendAfterSeconds: 60 });
    vi.mocked(authApi.verifySignupCode).mockResolvedValue({ user: USER, referral: 'not_applied' } as never);
    const user = userEvent.setup();
    setup();
    await screen.findByLabelText('Referral code');
    await submit(user);
    await user.type(await screen.findByRole('textbox', { name: /code/i }), '123456');
    await waitFor(() => expect(screen.getByTestId('onboarding-page')).toBeInTheDocument());
    expect(warning).toHaveBeenCalledWith(
      'The referral code is no longer valid and was not used. You can add a code in the membership panel.',
    );
  });

  it('forgets the carried code once Google made a new account with it', async () => {
    vi.stubGlobal('__GOOGLE_CLIENT_ID__', 'test.apps.googleusercontent.com');
    carry.code = 'ALICE';
    vi.mocked(authApi.google).mockResolvedValue({ user: USER, created: true, referral: 'applied' } as never);
    const user = userEvent.setup();
    setup();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(await screen.findByTestId('onboarding-page')).toBeInTheDocument();
    expect(carry.forget).toHaveBeenCalledTimes(1);
  });

  it('keeps the carried code when Google signed in to an existing account, for the panel to offer', async () => {
    vi.stubGlobal('__GOOGLE_CLIENT_ID__', 'test.apps.googleusercontent.com');
    carry.code = 'ALICE';
    vi.mocked(authApi.google).mockResolvedValue({ user: USER, created: false, referral: 'not_applied' } as never);
    const user = userEvent.setup();
    setup();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(warning).toHaveBeenCalled());
    expect(carry.forget).not.toHaveBeenCalled();
  });
});
