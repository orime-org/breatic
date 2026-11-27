// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type * as AuthModule from '@web/data/api/auth';
import type * as AnalyticsModule from '@web/data/analytics';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These cases cover the program's entry points as they behave once shown again (inner#2155).
vi.mock('@web/features/referral/referral-ui', () => ({ REFERRAL_UI_SHOWN: true }));
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
    authApi: { ...actual.authApi, options: vi.fn(), register: vi.fn(), verifySignupCode: vi.fn(), resendSignupCode: vi.fn(), me: vi.fn() },
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

vi.mock('@web/data/analytics', async () => {
  const actual = await vi.importActual<typeof AnalyticsModule>('@web/data/analytics');
  return { ...actual, trackEvent: vi.fn(), reportConversion: vi.fn(), attributionBody: () => ({}) };
});

import RegisterPage from '@web/pages/auth/RegisterPage';
import { authApi, type SignupReferralOutcome } from '@web/data/api/auth';
import { ApiException } from '@web/data/api/types';
import { useCurrentUserStore } from '@web/stores';
import { recordGoogleBeginPosts, sessionStorageText, type GoogleBeginPost } from './google-begin-harness';

const USER = { id: 'u1', email: 'foo@bar.com', personalStudio: null, membershipTier: 'base', locale: 'en' } as const;
const INVALID = 'This referral code is not valid. Change it, or clear it to continue.';

let recorder: { posts: GoogleBeginPost[]; stop: () => void };

/**
 * Renders the sign-up page at an address, with the routes it can leave for.
 * @param entry - The starting address.
 * @returns The unmount function, to leave the page as a full-page post does.
 */
function setup(entry = '/register'): () => void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path='/register' element={<RegisterPage />} />
          <Route path='/recovery-code' element={<div data-testid='recovery-page' />} />
          <Route path='/choose-slug' element={<div data-testid='onboarding-page' />} />
          <Route path='/studio' element={<div data-testid='studio-page' />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return view.unmount;
}

const google = (): Promise<HTMLElement> => screen.findByRole('button', { name: /continue with google/i });

/**
 * Type a code into the referral field, press the Google button, then leave
 * the page as the browser does on a form post.
 * @param user - The user-event instance.
 * @param code - What the user types.
 * @returns The post the browser sent.
 */
async function typeAndLeave(user: ReturnType<typeof userEvent.setup>, code: string): Promise<GoogleBeginPost> {
  const leave = setup();
  await user.type(await screen.findByLabelText('Referral code'), code);
  await user.click(await google());
  leave();
  expect(recorder.posts).toHaveLength(1);
  return recorder.posts[0]!;
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
  sessionStorage.clear();
  carry.code = null;
  useCurrentUserStore.setState({ user: null, role: null, loading: false, bootstrapped: true });
  vi.mocked(authApi.options).mockResolvedValue({ emailVerification: false, referralEnabled: true, googleSignIn: true, desktopAppScheme: 'ai.breatic.desktop', desktopAppName: 'Breatic' } as never);
  vi.mocked(authApi.me).mockResolvedValue(USER as never);
  recorder = recordGoogleBeginPosts();
});

afterEach(() => {
  recorder.stop();
});

describe('the sign-up page referral field (inner#1868 table 12.13)', () => {
  it('shows a placeholder and keeps Create account waiting while the options load', () => {
    vi.mocked(authApi.options).mockReturnValue(new Promise(() => {}));
    setup();
    expect(screen.getByTestId('register-referral-loading')).toBeInTheDocument();
    expect(screen.queryByLabelText('Referral code')).toBeNull();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled();
  });

  it('has no field and sends no code where nothing is sold', async () => {
    carry.code = 'ALICE';
    vi.mocked(authApi.options).mockResolvedValue({ emailVerification: false, referralEnabled: false, googleSignIn: true, desktopAppScheme: 'ai.breatic.desktop', desktopAppName: 'Breatic' } as never);
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
    // The page says what to do next instead of the server's bare refusal.
    expect(await screen.findByText('This referral code is not valid. Change it, or clear it to continue.')).toBeInTheDocument();
    expect(screen.getByLabelText('Referral code')).toHaveAttribute('aria-invalid', 'true');
    expect(carry.refused).toHaveBeenCalledWith('ALICE');
    expect(screen.queryByTestId('recovery-page')).toBeNull();
  });

  it('warns that the code was not used when step two reports it, then goes on', async () => {
    carry.code = 'ALICE';
    vi.mocked(authApi.options).mockResolvedValue({ emailVerification: true, referralEnabled: true, googleSignIn: true, desktopAppScheme: 'ai.breatic.desktop', desktopAppName: 'Breatic' } as never);
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

  it('shows no warning when step two reports the code is pending', async () => {
    carry.code = 'ALICE';
    vi.mocked(authApi.options).mockResolvedValue({ emailVerification: true, referralEnabled: true, googleSignIn: true, desktopAppScheme: 'ai.breatic.desktop', desktopAppName: 'Breatic' } as never);
    vi.mocked(authApi.register).mockResolvedValue({ status: 'code_sent', expiresInSeconds: 600, resendAfterSeconds: 60 });
    const pending: SignupReferralOutcome = 'pending';
    vi.mocked(authApi.verifySignupCode).mockResolvedValue({ user: USER, referral: pending } as never);
    const user = userEvent.setup();
    setup();
    await screen.findByLabelText('Referral code');
    await submit(user);
    await user.type(await screen.findByRole('textbox', { name: /code/i }), '123456');
    await waitFor(() => expect(screen.getByTestId('onboarding-page')).toBeInTheDocument());
    expect(warning).not.toHaveBeenCalled();
  });

});

describe('the sign-up page referral field with Google (inner#2157 §7.9)', () => {
  it('posts the carried code as from the link, saving it first', async () => {
    carry.code = 'ALICE';
    const user = userEvent.setup();
    setup();
    expect(await screen.findByLabelText('Referral code')).toHaveValue('ALICE');
    await user.click(await google());
    expect(recorder.posts).toHaveLength(1);
    expect(recorder.posts[0]!.fields.referralCode).toBe('ALICE');
    expect(recorder.posts[0]!.fields.referralSource).toBe('signup_link');
    expect(recorder.posts[0]!.storedAtSubmit).toContain('ALICE');
  });

  it('posts a typed code as typed and saves it before the post', async () => {
    const user = userEvent.setup();
    const post = await typeAndLeave(user, 'bob');
    expect(post.fields.referralCode).toBe('bob');
    expect(post.fields.referralSource).toBe('signup_typed');
    expect(post.storedAtSubmit).toContain('bob');
  });

  it('restores a typed code after googleError=cancelled, keeps it typed and clears the saved copy', async () => {
    const user = userEvent.setup();
    await typeAndLeave(user, 'bob');
    setup('/register?googleError=cancelled');
    await waitFor(() => expect(screen.getByLabelText('Referral code')).toHaveValue('bob'));
    await waitFor(() => expect(sessionStorageText()).not.toContain('bob'));
    await user.click(await google());
    expect(recorder.posts).toHaveLength(2);
    expect(recorder.posts[1]!.fields.referralCode).toBe('bob');
    expect(recorder.posts[1]!.fields.referralSource).toBe('signup_typed');
  });

  it('keeps a restored carried code as from the link', async () => {
    carry.code = 'ALICE';
    const user = userEvent.setup();
    const leave = setup();
    await screen.findByLabelText('Referral code');
    await user.click(await google());
    leave();
    setup('/register?googleError=cancelled');
    await waitFor(() => expect(screen.getByLabelText('Referral code')).toHaveValue('ALICE'));
    await user.click(await google());
    expect(recorder.posts[1]!.fields.referralSource).toBe('signup_link');
  });

  it('keeps a cleared carried code cleared after googleError=cancelled, posting no code', async () => {
    carry.code = 'ALICE';
    const user = userEvent.setup();
    const leave = setup();
    await user.clear(await screen.findByLabelText('Referral code'));
    await user.click(await google());
    leave();
    setup('/register?googleError=cancelled');
    await waitFor(() => expect(screen.getByLabelText('Referral code')).toBeEnabled());
    expect(screen.getByLabelText('Referral code')).toHaveValue('');
    await user.click(await google());
    expect(recorder.posts).toHaveLength(2);
    expect(recorder.posts[1]!.fields.referralCode).toBeUndefined();
  });

  it('clears the saved copy after google=created too', async () => {
    const user = userEvent.setup();
    await typeAndLeave(user, 'bob');
    setup('/register?google=created');
    expect(await screen.findByTestId('onboarding-page')).toBeInTheDocument();
    await waitFor(() => expect(sessionStorageText()).not.toContain('bob'));
  });

  it('does not restore the saved code on a plain visit', async () => {
    const user = userEvent.setup();
    await typeAndLeave(user, 'bob');
    setup('/register');
    await waitFor(() => expect(screen.getByLabelText('Referral code')).toBeEnabled());
    expect(screen.getByLabelText('Referral code')).toHaveValue('');
  });

  it('marks the restored code invalid after googleError=referral_invalid', async () => {
    const user = userEvent.setup();
    await typeAndLeave(user, 'bob');
    setup('/register?googleError=referral_invalid');
    expect(await screen.findByText(INVALID)).toBeInTheDocument();
    expect(screen.getByLabelText('Referral code')).toHaveValue('bob');
    expect(screen.getByLabelText('Referral code')).toHaveAttribute('aria-invalid', 'true');
    expect(carry.refused).toHaveBeenCalledWith('bob');
    expect(screen.queryByTestId('onboarding-page')).toBeNull();
  });

  it('names the refused carried code after googleError=referral_invalid', async () => {
    carry.code = 'ALICE';
    const user = userEvent.setup();
    const leave = setup();
    await screen.findByLabelText('Referral code');
    await user.click(await google());
    leave();
    setup('/register?googleError=referral_invalid');
    expect(await screen.findByText(INVALID)).toBeInTheDocument();
    expect(carry.refused).toHaveBeenCalledWith('ALICE');
  });

  it('forgets the carried code once Google made a new account with it, with no warning', async () => {
    carry.code = 'ALICE';
    setup('/register?google=created');
    expect(await screen.findByTestId('onboarding-page')).toBeInTheDocument();
    expect(carry.forget).toHaveBeenCalledTimes(1);
    expect(warning).not.toHaveBeenCalled();
  });

  it('keeps the carried code and warns when Google signed in to an existing account with referral=not_applied', async () => {
    carry.code = 'ALICE';
    setup('/register?google=signed_in&referral=not_applied');
    expect(await screen.findByTestId('studio-page')).toBeInTheDocument();
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      'This account already exists, so the referral code was not used. If you have not had a membership yet, you can add it in the membership panel.',
    );
    expect(carry.forget).not.toHaveBeenCalled();
  });
});
