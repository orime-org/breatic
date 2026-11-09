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
  return { ...actual, authApi: { ...actual.authApi, options: vi.fn(), google: vi.fn(), login: vi.fn() } };
});
vi.mock('@web/lib/referral-carry', () => ({
  carriedReferralCode: () => carry.code,
  forgetCarriedReferralCode: () => {
    carry.forget();
    carry.code = null;
  },
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

import LoginPage from '@web/pages/auth/LoginPage';
import { authApi } from '@web/data/api/auth';
import { ApiException } from '@web/data/api/types';
import { useCurrentUserStore } from '@web/stores';

const USER = { id: 'u1', email: 'foo@bar.com', personalStudio: null, membershipTier: 'base', locale: 'en' } as const;
const REFUSED = new ApiException({ status: 422, message: 'This referral code is not valid.', fromServer: true, reason: 'invalid_code' });

/** Renders the sign-in page with the page it goes to. */
function setup(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path='/login' element={<LoginPage />} />
          <Route path='/studio' element={<div data-testid='studio-page' />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const google = (): HTMLElement => screen.getByRole('button', { name: 'Continue with Google' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('__GOOGLE_CLIENT_ID__', 'test.apps.googleusercontent.com');
  carry.code = null;
  useCurrentUserStore.setState({ user: null, role: null, loading: false, bootstrapped: true });
  vi.mocked(authApi.options).mockResolvedValue({ emailVerification: false, referralEnabled: true });
});

describe('the sign-in page referral row (inner#1868 table 12.14)', () => {
  it('shows a placeholder and keeps Google waiting while the options load', () => {
    vi.mocked(authApi.options).mockReturnValue(new Promise(() => {}));
    setup();
    expect(screen.getByTestId('login-referral-loading')).toBeInTheDocument();
    expect(google()).toBeDisabled();
  });

  it('names the carried code and sends it with a new Google account', async () => {
    carry.code = 'ALICE';
    vi.mocked(authApi.google).mockResolvedValue({ user: USER, created: true, referral: 'applied' } as never);
    const user = userEvent.setup();
    setup();
    expect(await screen.findByText(/will use referral code/)).toHaveTextContent('ALICE');
    expect(screen.getByText('ALICE')).toHaveClass('font-semibold');
    await user.click(google());
    expect(authApi.google).toHaveBeenCalledWith(expect.objectContaining({ referralCode: 'ALICE', referralSource: 'signup_link' }));
    await waitFor(() => expect(carry.forget).toHaveBeenCalled());
  });

  it('drops the carried code when removed and sends none afterwards', async () => {
    carry.code = 'ALICE';
    vi.mocked(authApi.google).mockResolvedValue({ user: USER, created: true } as never);
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('button', { name: 'Don\'t use this code' }));
    expect(screen.queryByText(/will use referral code/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Have a referral code?' })).toBeInTheDocument();
    expect(carry.forget).toHaveBeenCalled();
    await user.click(google());
    expect(vi.mocked(authApi.google).mock.calls[0]![0]).not.toHaveProperty('referralCode');
  });

  it('marks a refused carried code as no longer valid and stops sending it', async () => {
    carry.code = 'ALICE';
    vi.mocked(authApi.google).mockRejectedValueOnce(REFUSED).mockResolvedValueOnce({ user: USER, created: true } as never);
    const user = userEvent.setup();
    setup();
    await screen.findByText(/will use referral code/);
    await user.click(google());
    expect(await screen.findByText(/is no longer valid/)).toHaveTextContent('Referral code ALICE is no longer valid');
    await user.click(google());
    expect(vi.mocked(authApi.google).mock.calls[1]![0]).not.toHaveProperty('referralCode');
  });

  it('opens a field for a typed code, sends it, and shows a refusal under it', async () => {
    vi.mocked(authApi.google).mockRejectedValue(REFUSED);
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('button', { name: 'Have a referral code?' }));
    expect(screen.getByLabelText('Referral code')).toHaveAttribute('maxLength', '40');
    await user.type(screen.getByLabelText('Referral code'), 'bob');
    await user.click(google());
    expect(authApi.google).toHaveBeenCalledWith(expect.objectContaining({ referralCode: 'bob', referralSource: 'signup_typed' }));
    expect(await screen.findByText('This referral code is not valid. Change it, or clear it to continue.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Referral code'), 'x');
    expect(screen.queryByText('This referral code is not valid. Change it, or clear it to continue.')).toBeNull();
  });

  it('warns before navigating when Google signs in to an existing account carrying a code', async () => {
    carry.code = 'ALICE';
    vi.mocked(authApi.google).mockResolvedValue({ user: USER, created: false, referral: 'not_applied' } as never);
    const user = userEvent.setup();
    setup();
    await screen.findByText(/will use referral code/);
    await user.click(google());
    await waitFor(() => expect(warning).toHaveBeenCalledWith(
      'This account already exists, so the referral code was not used. If you have not had a membership yet, you can add it in the membership panel.',
    ));
    // The warning sends the user to the panel, whose field fills from the carried code.
    expect(carry.forget).not.toHaveBeenCalled();
  });

  it('has no referral row while payments are off', async () => {
    carry.code = 'ALICE';
    vi.mocked(authApi.options).mockResolvedValue({ emailVerification: false, referralEnabled: false });
    setup();
    await waitFor(() => expect(google()).toBeEnabled());
    expect(screen.queryByText(/will use referral code/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Have a referral code?' })).toBeNull();
  });
});
