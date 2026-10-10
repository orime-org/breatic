// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import RegisterPage from '@web/pages/auth/RegisterPage';
import RecoveryCodePage from '@web/pages/auth/RecoveryCodePage';
import { authApi } from '@web/data/api/auth';
import { ApiException } from '@web/data/api/types';
import { useCurrentUserStore } from '@web/stores';

// Mock only the network-touching calls; keep types + deriveDisplayName real.
vi.mock('@web/data/api/auth', async () => {
  const actual =
    await vi.importActual<typeof import('@web/data/api/auth')>(
      '@web/data/api/auth',
    );
  return {
    ...actual,
    authApi: { register: vi.fn(), verifySignupCode: vi.fn(), resendSignupCode: vi.fn() },
  };
});

const USER = { id: 'u1', email: 'foo@bar.com', personalStudio: null, membershipTier: 'base', locale: 'en' } as const;
const CODE_SENT = { status: 'code_sent', expiresInSeconds: 600, resendAfterSeconds: 60 } as const;

function setup() {
  return render(
    <MemoryRouter initialEntries={['/register']}>
      <Routes>
        <Route path='/register' element={<RegisterPage />} />
        <Route path='/recovery-code' element={<RecoveryCodePage />} />
        <Route
          path='/choose-slug'
          element={<div data-testid='onboarding-page' />}
        />
        <Route path='/studio' element={<div data-testid='studio-page' />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** An API refusal the way the request wrapper builds one. */
function refusal(status: number, message: string, retryAfterSeconds?: number): ApiException {
  return new ApiException({ status, message, fromServer: true, retryAfterSeconds });
}

/** Fill the form and submit it. */
async function submitForm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText('Email'), 'foo@bar.com');
  await user.type(screen.getByLabelText('Password'), 'supersecret');
  await user.click(screen.getByRole('button', { name: 'Create account' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  useCurrentUserStore.setState({
    user: null,
    role: null,
    loading: false,
    bootstrapped: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RegisterPage without email (two-step entry)', () => {
  it('shows the development build label on the registration card', () => {
    setup();
    expect(screen.getByText('dev')).toBeInTheDocument();
  });

  // The username rewrite removed the free-form "Name" field entirely —
  // identity now comes from the onboarding slug, not registration.
  it('renders email + password only, with no name field', () => {
    setup();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it('registers with email + password only (no name in the request body)', async () => {
    vi.mocked(authApi.register).mockResolvedValueOnce({
      status: 'created',
      user: USER,
      recoveryCode: 'AAAA-BBBB-CCCC-DDDD',
    });
    const user = userEvent.setup();
    setup();
    await submitForm(user);

    await waitFor(() =>
      expect(authApi.register).toHaveBeenCalledWith({
        email: 'foo@bar.com',
        password: 'supersecret',
      }),
    );
    // Step one leaves the user gated (personalStudio null) in the store.
    expect(useCurrentUserStore.getState().user?.personalStudio).toBeNull();
  });

  // INVARIANT (design §5.1): after acknowledging the recovery code, the
  // user is sent to step two (the onboarding slug page), NOT straight to
  // /studio — a half-finished sign-up must complete onboarding first.
  it('continue from the recovery screen navigates to /choose-slug (not /studio)', async () => {
    vi.mocked(authApi.register).mockResolvedValueOnce({
      status: 'created',
      user: USER,
      recoveryCode: 'AAAA-BBBB-CCCC-DDDD',
    });
    const user = userEvent.setup();
    setup();
    await submitForm(user);

    // The recovery-code screen gates Continue behind the ack checkbox.
    const ack = await screen.findByLabelText(
      /I have saved this recovery code/i,
    );
    await user.click(ack);
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(screen.getByTestId('onboarding-page')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('studio-page')).not.toBeInTheDocument();
  });
});

describe('RegisterPage with email (code step, #287)', () => {
  it('asks for the code on the same card after the form is sent (A1)', async () => {
    vi.mocked(authApi.register).mockResolvedValueOnce(CODE_SENT);
    const user = userEvent.setup();
    setup();
    await submitForm(user);

    expect(await screen.findByRole('heading', { name: 'Verify your email' })).toBeInTheDocument();
    expect(screen.getByText('foo@bar.com')).toBeInTheDocument();
    expect(screen.getByLabelText('Verification code')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Resend in 60s' })).toBeDisabled();
  });

  it('creates the account from a matching code and goes to the slug step, never the recovery code (A2)', async () => {
    vi.mocked(authApi.register).mockResolvedValueOnce(CODE_SENT);
    vi.mocked(authApi.verifySignupCode).mockResolvedValueOnce({ user: USER });
    const user = userEvent.setup();
    setup();
    await submitForm(user);
    await user.type(await screen.findByLabelText('Verification code'), '123456');

    await waitFor(() => expect(screen.getByTestId('onboarding-page')).toBeInTheDocument());
    expect(authApi.verifySignupCode).toHaveBeenCalledWith({ code: '123456' });
    expect(authApi.verifySignupCode).toHaveBeenCalledTimes(1);
    expect(useCurrentUserStore.getState().user?.personalStudio).toBeNull();
    expect(screen.queryByText(/recovery code/i)).not.toBeInTheDocument();
  });

  it('clears the boxes and shows why after a wrong code, and a later code is sent again (A3)', async () => {
    vi.mocked(authApi.register).mockResolvedValueOnce(CODE_SENT);
    vi.mocked(authApi.verifySignupCode)
      .mockRejectedValueOnce(refusal(400, 'That code is incorrect.'))
      .mockResolvedValueOnce({ user: USER });
    const user = userEvent.setup();
    setup();
    await submitForm(user);
    const input = await screen.findByLabelText('Verification code');
    await user.type(input, '111111');

    expect(await screen.findByText('That code is incorrect.')).toBeInTheDocument();
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();

    await user.type(input, '222222');
    await waitFor(() => expect(screen.getByTestId('onboarding-page')).toBeInTheDocument());
  });

  it('marks every box after a wrong code and clears the mark once typing starts again', async () => {
    vi.mocked(authApi.register).mockResolvedValueOnce(CODE_SENT);
    vi.mocked(authApi.verifySignupCode).mockRejectedValueOnce(refusal(400, 'That code is incorrect.'));
    const user = userEvent.setup();
    const { container } = setup();
    await submitForm(user);
    const input = await screen.findByLabelText('Verification code');
    const slots = (): Element[] => Array.from(container.querySelectorAll('[data-slot="input-otp-slot"]'));

    expect(slots()).toHaveLength(6);
    expect(slots().every((s) => !s.hasAttribute('aria-invalid'))).toBe(true);

    await user.type(input, '111111');
    await screen.findByText('That code is incorrect.');
    expect(slots().every((s) => s.getAttribute('aria-invalid') === 'true')).toBe(true);

    await user.type(input, '2');
    expect(slots().every((s) => !s.hasAttribute('aria-invalid'))).toBe(true);
    expect(screen.getByText('That code is incorrect.')).toBeInTheDocument();
  });

  it('keeps the message line in place before any message, so the boxes do not move', async () => {
    vi.mocked(authApi.register).mockResolvedValueOnce(CODE_SENT);
    const user = userEvent.setup();
    setup();
    await submitForm(user);
    await screen.findByLabelText('Verification code');

    const line = screen.getByTestId('signup-code-message');
    expect(line).toBeEmptyDOMElement();
  });

  it('shows what the server says when the address got an account while the code was pending', async () => {
    vi.mocked(authApi.register).mockResolvedValueOnce(CODE_SENT);
    vi.mocked(authApi.verifySignupCode).mockRejectedValueOnce(
      refusal(409, 'This email is already registered.'),
    );
    const user = userEvent.setup();
    setup();
    await submitForm(user);
    await user.type(await screen.findByLabelText('Verification code'), '123456');

    expect(await screen.findByText('This email is already registered.')).toBeInTheDocument();
  });

  it('locks the boxes once the code is used up and leaves resend as the way on (A5)', async () => {
    vi.mocked(authApi.register).mockResolvedValueOnce({ ...CODE_SENT, resendAfterSeconds: 0 });
    vi.mocked(authApi.verifySignupCode).mockRejectedValueOnce(
      refusal(422, 'This code can no longer be used. Request a new one.'),
    );
    const user = userEvent.setup();
    setup();
    await submitForm(user);
    const input = await screen.findByLabelText('Verification code');
    await user.type(input, '111111');

    expect(await screen.findByText('This code can no longer be used. Request a new one.')).toBeInTheDocument();
    expect(input).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Resend code' })).toBeEnabled();
  });

  it('sends a fresh code on resend and unlocks the boxes (A4)', async () => {
    vi.mocked(authApi.register).mockResolvedValueOnce({ ...CODE_SENT, resendAfterSeconds: 0 });
    vi.mocked(authApi.verifySignupCode).mockRejectedValueOnce(
      refusal(422, 'This code can no longer be used. Request a new one.'),
    );
    vi.mocked(authApi.resendSignupCode).mockResolvedValueOnce(CODE_SENT);
    const user = userEvent.setup();
    setup();
    await submitForm(user);
    const input = await screen.findByLabelText('Verification code');
    await user.type(input, '111111');
    await user.click(await screen.findByRole('button', { name: 'Resend code' }));

    expect(await screen.findByText('We sent you a new code.')).toBeInTheDocument();
    expect(input).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Resend in 60s' })).toBeDisabled();
  });

  it('counts the resend wait down a second at a time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(authApi.register).mockResolvedValueOnce({ ...CODE_SENT, resendAfterSeconds: 2 });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setup();
    await submitForm(user);
    expect(await screen.findByRole('button', { name: 'Resend in 2s' })).toBeDisabled();

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('button', { name: 'Resend in 1s' })).toBeDisabled();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('button', { name: 'Resend code' })).toBeEnabled();
  });

  it('starts over by itself when the sign-up has expired, using the email and password it still holds', async () => {
    vi.mocked(authApi.register)
      .mockResolvedValueOnce(CODE_SENT)
      .mockResolvedValueOnce(CODE_SENT);
    vi.mocked(authApi.verifySignupCode).mockRejectedValueOnce(refusal(410, 'This sign-up has expired.'));
    const user = userEvent.setup();
    setup();
    await submitForm(user);
    await user.type(await screen.findByLabelText('Verification code'), '123456');

    expect(await screen.findByText('We sent you a new code.')).toBeInTheDocument();
    expect(authApi.register).toHaveBeenCalledTimes(2);
    expect(authApi.register).toHaveBeenLastCalledWith({ email: 'foo@bar.com', password: 'supersecret' });
    expect(screen.getByRole('heading', { name: 'Verify your email' })).toBeInTheDocument();
  });

  it('shows the wait the server gives when the form is sent again too soon', async () => {
    vi.mocked(authApi.register).mockRejectedValueOnce(
      refusal(429, 'Wait 38 seconds before requesting another code.', 38),
    );
    const user = userEvent.setup();
    setup();
    await submitForm(user);
    expect(await screen.findByText('Wait 38 seconds before requesting another code.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
  });

  it('goes back to the form with what was typed when the reader changes the email', async () => {
    vi.mocked(authApi.register).mockResolvedValueOnce(CODE_SENT);
    const user = userEvent.setup();
    setup();
    await submitForm(user);
    await user.click(await screen.findByRole('button', { name: 'Use a different email' }));

    expect(screen.getByLabelText('Email')).toHaveValue('foo@bar.com');
    expect(screen.getByLabelText('Password')).toHaveValue('supersecret');
  });

  // #302: the terms line sits at the foot of the card, after the cross-link.
  it('shows the terms line under the footer', () => {
    setup();
    const notice = screen.getByTestId('auth-terms-notice');
    expect(notice.previousElementSibling?.tagName).toBe('FOOTER');
    expect(notice.previousElementSibling).toHaveTextContent('Already have an account?');
    expect(within(notice).getByRole('link', { name: 'Terms of Service' })).toBeInTheDocument();
  });
});
