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
  return { ...actual, authApi: { ...actual.authApi, options: vi.fn(), me: vi.fn(), login: vi.fn() } };
});
vi.mock('@web/data/analytics', async () => {
  const actual = await vi.importActual<typeof AnalyticsModule>('@web/data/analytics');
  return { ...actual, trackEvent: vi.fn(), reportConversion: vi.fn(), attributionBody: () => ({}) };
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

import LoginPage from '@web/pages/auth/LoginPage';
import { authApi } from '@web/data/api/auth';
import { reportConversion } from '@web/data/analytics';
import { useCurrentUserStore } from '@web/stores';
import { recordGoogleBeginPosts, sessionStorageText, type GoogleBeginPost } from './google-begin-harness';

const USER = { id: 'u1', email: 'foo@bar.com', personalStudio: null, membershipTier: 'base', locale: 'en' } as const;
const INVALID = 'This referral code is not valid. Change it, or clear it to continue.';

let recorder: { posts: GoogleBeginPost[]; stop: () => void };

/**
 * Renders the sign-in page at an address, with the page it goes to.
 * @param entry - The starting address.
 * @returns The unmount function, to leave the page as a full-page post does.
 */
function setup(entry = '/login'): () => void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path='/login' element={<LoginPage />} />
          <Route path='/studio' element={<div data-testid='studio-page' />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return view.unmount;
}

const google = (): Promise<HTMLElement> => screen.findByRole('button', { name: /continue with google/i });

/**
 * Type a code into the opened referral field and press the Google button,
 * then leave the page as the browser does on a form post.
 * @param user - The user-event instance.
 * @param code - What the user types.
 * @returns The post the browser sent.
 */
async function typeAndLeave(user: ReturnType<typeof userEvent.setup>, code: string): Promise<GoogleBeginPost> {
  const leave = setup();
  await user.click(await screen.findByRole('button', { name: 'Have a referral code?' }));
  await user.type(screen.getByLabelText('Referral code'), code);
  await user.click(await google());
  leave();
  expect(recorder.posts).toHaveLength(1);
  return recorder.posts[0]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  carry.code = null;
  useCurrentUserStore.setState({ user: null, role: null, loading: false, bootstrapped: true });
  vi.mocked(authApi.options).mockResolvedValue({ emailVerification: false, referralEnabled: true, googleSignIn: true } as never);
  vi.mocked(authApi.me).mockResolvedValue(USER as never);
  recorder = recordGoogleBeginPosts();
});

afterEach(() => {
  recorder.stop();
});

describe('the sign-in page referral row with Google (inner#2157 §7.9)', () => {
  it('names the carried code and posts it as from the link, saving it first', async () => {
    carry.code = 'ALICE';
    const user = userEvent.setup();
    setup();
    expect(await screen.findByText(/will use referral code/)).toHaveTextContent('ALICE');
    await user.click(await google());
    expect(recorder.posts).toHaveLength(1);
    expect(recorder.posts[0]!.fields.referralCode).toBe('ALICE');
    expect(recorder.posts[0]!.fields.referralSource).toBe('signup_link');
    expect(recorder.posts[0]!.storedAtSubmit).toContain('ALICE');
  });

  it('drops the carried code when removed and posts none afterwards', async () => {
    carry.code = 'ALICE';
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('button', { name: 'Don\'t use this code' }));
    expect(screen.queryByText(/will use referral code/)).toBeNull();
    expect(carry.forget).toHaveBeenCalled();
    await user.click(await google());
    expect(recorder.posts[0]!.fields.referralCode ?? '').toBe('');
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
    setup('/login?googleError=cancelled');
    expect(await screen.findByLabelText('Referral code')).toHaveValue('bob');
    await waitFor(() => expect(sessionStorageText()).not.toContain('bob'));
    await user.click(await google());
    expect(recorder.posts).toHaveLength(2);
    expect(recorder.posts[1]!.fields.referralCode).toBe('bob');
    expect(recorder.posts[1]!.fields.referralSource).toBe('signup_typed');
  });

  it('restores the code after google=signed_in too and clears the saved copy', async () => {
    const user = userEvent.setup();
    await typeAndLeave(user, 'bob');
    setup('/login?google=signed_in&referral=not_applied');
    await waitFor(() => expect(sessionStorageText()).not.toContain('bob'));
  });

  it('does not restore the saved code on a plain visit', async () => {
    const user = userEvent.setup();
    await typeAndLeave(user, 'bob');
    setup('/login');
    expect(await screen.findByRole('button', { name: 'Have a referral code?' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Referral code')).toBeNull();
  });

  it('marks a typed code invalid after googleError=referral_invalid', async () => {
    const user = userEvent.setup();
    await typeAndLeave(user, 'bob');
    setup('/login?googleError=referral_invalid');
    expect(await screen.findByText(INVALID)).toBeInTheDocument();
    expect(screen.getByLabelText('Referral code')).toHaveValue('bob');
    expect(screen.getByLabelText('Referral code')).toHaveAttribute('aria-invalid', 'true');
    expect(carry.refused).toHaveBeenCalledWith('bob');
  });

  it('marks a carried code as no longer valid after googleError=referral_invalid and stops posting it', async () => {
    carry.code = 'ALICE';
    const user = userEvent.setup();
    const leave = setup();
    await screen.findByText(/will use referral code/);
    await user.click(await google());
    leave();
    setup('/login?googleError=referral_invalid');
    expect(await screen.findByText(/is no longer valid/)).toHaveTextContent('Referral code ALICE is no longer valid');
    expect(carry.refused).toHaveBeenCalledWith('ALICE');
    await user.click(await google());
    expect(recorder.posts).toHaveLength(2);
    expect(recorder.posts[1]!.fields.referralCode ?? '').toBe('');
  });

  it('forgets the carried code and reports the conversion when Google made a new account', async () => {
    carry.code = 'ALICE';
    setup('/login?google=created');
    await waitFor(() => expect(carry.forget).toHaveBeenCalledTimes(1));
    expect(reportConversion).toHaveBeenCalledExactlyOnceWith('signup', 'signup:u1');
    expect(warning).not.toHaveBeenCalled();
  });

  it('warns and keeps the carried code when Google signed in to an existing account with referral=not_applied', async () => {
    carry.code = 'ALICE';
    setup('/login?google=signed_in&referral=not_applied');
    expect(await screen.findByTestId('studio-page')).toBeInTheDocument();
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      'This account already exists, so the referral code was not used. If you have not had a membership yet, you can add it in the membership panel.',
    );
    // The warning sends the user to the panel, whose field fills from the carried code.
    expect(carry.forget).not.toHaveBeenCalled();
    expect(reportConversion).not.toHaveBeenCalled();
  });

  it('has no referral row where nothing is sold', async () => {
    carry.code = 'ALICE';
    vi.mocked(authApi.options).mockResolvedValue({ emailVerification: false, referralEnabled: false, googleSignIn: true } as never);
    setup();
    await google();
    expect(screen.queryByText(/will use referral code/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Have a referral code?' })).toBeNull();
  });
});
