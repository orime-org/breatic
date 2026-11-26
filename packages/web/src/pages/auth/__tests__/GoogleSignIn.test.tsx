// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

// Google sign-in as a full-page form post to the begin endpoint, and what the
// login and register pages do when the callback sends the browser back
// (inner#2157 design §7.9, §8 row "Google sign-in, page side").

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Attribution } from '@breatic/shared';
import { getLocale } from '@breatic/shared';
import en from '@locales/en.json';

import type * as AuthModule from '@web/data/api/auth';
import type * as AnalyticsModule from '@web/data/analytics';

vi.mock('@web/data/api/auth', async () => {
  const actual = await vi.importActual<typeof AuthModule>('@web/data/api/auth');
  return { ...actual, authApi: { ...actual.authApi, options: vi.fn(), me: vi.fn(), login: vi.fn(), register: vi.fn(), invitation: vi.fn() } };
});
vi.mock('@web/data/analytics', async () => {
  const actual = await vi.importActual<typeof AnalyticsModule>('@web/data/analytics');
  return { ...actual, trackEvent: vi.fn(), reportConversion: vi.fn(), attributionBody: vi.fn() };
});

import LoginPage from '@web/pages/auth/LoginPage';
import RegisterPage from '@web/pages/auth/RegisterPage';
import { authApi } from '@web/data/api/auth';
import { attributionBody, reportConversion, trackEvent } from '@web/data/analytics';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { useCurrentUserStore } from '@web/stores/current-user';
import { readPath } from '@web/test-utils/locale-catalogs';
import {
  BEGIN_ACTION,
  LocationProbe,
  readLocation,
  recordGoogleBeginPosts,
  type GoogleBeginPost,
} from './google-begin-harness';

const USER = { id: 'g-1', email: 'demo@gmail.com', personalStudio: null, membershipTier: 'base', locale: 'en' } as const;
const ATTRIBUTION: Attribution = {
  first: { utm_source: 'newsletter', landing_page: '/register', at: '2026-11-20T08:00:00.000Z' },
  last: { utm_source: 'video', landing_page: '/login', at: '2026-11-25T09:30:00.000Z' },
};

let recorder: { posts: GoogleBeginPost[]; stop: () => void };

/**
 * Render the auth pages at one address, with the places they can go and a
 * probe that always shows the current address.
 * @param entry - The starting address.
 */
function renderAt(entry: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path='/login' element={<LoginPage />} />
          <Route path='/register' element={<RegisterPage />} />
          <Route path='/studio' element={<div data-testid='studio-page' />} />
          <Route path='/decision' element={<div data-testid='decision-page' />} />
          <Route path='/choose-slug' element={<div data-testid='slug-page' />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * The Google button, once the deployment options say it is available.
 * @returns The button.
 */
async function googleButton(): Promise<HTMLElement> {
  return screen.findByRole('button', { name: /continue with google/i });
}

/**
 * The English text of a catalog key; fails when the key is missing.
 * @param key - Dotted catalog key.
 * @returns The message.
 */
function english(key: string): string {
  const message = readPath(en, key);
  expect(typeof message, `missing en.json key ${key}`).toBe('string');
  return message as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  useCurrentUserStore.setState({ user: null, loading: false, bootstrapped: true });
  document.documentElement.dataset.theme = 'light';
  vi.mocked(authApi.options).mockResolvedValue({ emailVerification: false, referralEnabled: false, googleSignIn: true } as never);
  vi.mocked(authApi.me).mockResolvedValue(USER as never);
  vi.mocked(attributionBody).mockReturnValue({});
  recorder = recordGoogleBeginPosts();
});

afterEach(() => {
  recorder.stop();
});

describe('the Google sign-in form', () => {
  it('posts from the login page to the begin endpoint with page, next, locale and attribution', async () => {
    vi.mocked(attributionBody).mockReturnValue({ attribution: ATTRIBUTION });
    const user = userEvent.setup();
    renderAt(`/login?next=${encodeURIComponent('/decision?token=abc')}`);
    await user.click(await googleButton());
    expect(recorder.posts).toHaveLength(1);
    const [post] = recorder.posts;
    expect(post!.form.getAttribute('action')).toBe(BEGIN_ACTION);
    expect(BEGIN_ACTION).toBe('/api/v1/auth/google/begin');
    expect(post!.form.method).toBe('post');
    expect(post!.fields.page).toBe('login');
    expect(post!.fields.next).toBe('/decision?token=abc');
    expect(post!.fields.locale).toBe('en');
    expect(JSON.parse(post!.fields.attribution!)).toEqual(ATTRIBUTION);
  });

  it('posts from the register page with page=register', async () => {
    const user = userEvent.setup();
    renderAt('/register');
    await user.click(await googleButton());
    expect(recorder.posts).toHaveLength(1);
    expect(recorder.posts[0]!.form.getAttribute('action')).toBe(BEGIN_ACTION);
    expect(recorder.posts[0]!.fields.page).toBe('register');
    expect(recorder.posts[0]!.fields.next).toBe('/studio');
  });

  it('sends the interface language in the locale field', async () => {
    await changeLocale('ja');
    try {
      const user = userEvent.setup();
      renderAt('/login');
      // The label is Japanese now, so the button is found through its form.
      await waitFor(() => expect(document.querySelector(`form[action="${BEGIN_ACTION}"] button`)).not.toBeNull());
      await user.click(document.querySelector<HTMLButtonElement>(`form[action="${BEGIN_ACTION}"] button`)!);
      expect(recorder.posts[0]!.fields.locale).toBe('ja');
    } finally {
      await changeLocale('en');
    }
  });

  it('reports signup_started when the form is submitted', async () => {
    const user = userEvent.setup();
    renderAt('/register');
    await user.click(await googleButton());
    expect(trackEvent).toHaveBeenCalledWith('signup_started', { method: 'google' });
  });

  it('enters the waiting state after the press and does not post twice', async () => {
    const user = userEvent.setup();
    renderAt('/login');
    const button = await googleButton();
    await user.click(button);
    await waitFor(() => expect(button).toHaveAttribute('aria-busy', 'true'));
    await user.click(button);
    expect(recorder.posts).toHaveLength(1);
  });

  it.each(['/login', '/register'])('shows no Google button on %s when the server has no Google sign-in', async (entry) => {
    vi.mocked(authApi.options).mockResolvedValue({ emailVerification: false, referralEnabled: false, googleSignIn: false } as never);
    renderAt(entry);
    await waitFor(() => expect(authApi.options).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('button', { name: /continue with google/i })).toBeNull();
    expect(document.querySelector(`form[action="${BEGIN_ACTION}"]`)).toBeNull();
  });

  it.each(['/login', '/register'])('loads no Google script on %s', async (entry) => {
    renderAt(entry);
    await googleButton();
    expect(document.querySelector('script[src^="https://accounts.google.com/gsi/client"]')).toBeNull();
  });
});

describe('returning from Google with a session', () => {
  it.each([
    ['/decision?token=google-invitation', '/decision?token=google-invitation'],
    ['//outside.example/path', '/studio'],
    ['https://outside.example/path', '/studio'],
  ])('signs in on the login page and goes safely to next=%s', async (next, destination) => {
    renderAt(`/login?google=signed_in&next=${encodeURIComponent(next)}`);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(destination));
    expect(screen.getByTestId('location').textContent).toBe(destination);
    expect(authApi.me).toHaveBeenCalledTimes(1);
    expect(useCurrentUserStore.getState().user?.id).toBe('g-1');
    expect(reportConversion).not.toHaveBeenCalled();
  });

  it('switches the interface to the account language', async () => {
    vi.mocked(authApi.me).mockResolvedValue({ ...USER, locale: 'zh-TW' } as never);
    try {
      renderAt('/login?google=signed_in');
      await waitFor(() => expect(getLocale()).toBe('zh-TW'));
    } finally {
      await changeLocale('en');
    }
  });

  it('reports the sign-up conversion and goes to choose a slug for a new account on the register page', async () => {
    renderAt('/register?google=created');
    expect(await screen.findByTestId('slug-page')).toBeInTheDocument();
    expect(screen.getByTestId('location').textContent).toBe('/choose-slug');
    expect(reportConversion).toHaveBeenCalledExactlyOnceWith('signup', 'signup:g-1');
    expect(useCurrentUserStore.getState().user?.id).toBe('g-1');
  });

  it('goes to next for an existing account on the register page', async () => {
    renderAt('/register?google=signed_in');
    expect(await screen.findByTestId('studio-page')).toBeInTheDocument();
    expect(screen.getByTestId('location').textContent).toBe('/studio');
    expect(reportConversion).not.toHaveBeenCalled();
  });
});

const ERRORS: Array<[string, string]> = [
  ['cancelled', 'auth.google.cancelled'],
  ['expired', 'auth.google.expired'],
  ['rate_limited', 'auth.google.rateLimited'],
  ['unavailable', 'auth.google.unavailable'],
  ['invalid_credential', 'server.auth.invalid_google_credential'],
  ['email_unverified', 'server.auth.google_email_unverified'],
  ['link_requires_email_login', 'server.auth.google_link_requires_email_login'],
];

describe('the page query across the Google round trip', () => {
  it('puts next back when an expired return comes without it', async () => {
    const user = userEvent.setup();
    renderAt(`/login?next=${encodeURIComponent('/project/abc')}`);
    await user.click(await googleButton());
    cleanup();

    renderAt('/login?googleError=expired');
    expect(await screen.findByText(english('auth.google.expired'))).toBeInTheDocument();
    await waitFor(() => expect(readLocation(screen.getByTestId('location')).params.get('next')).toBe('/project/abc'));
    expect(readLocation(screen.getByTestId('location')).params.has('googleError')).toBe(false);
  });

  it('puts the invitation back on the sign-up page after an error return', async () => {
    vi.mocked(authApi.invitation).mockResolvedValue({ state: 'open', email: 'invitee@example.test', inviterName: 'Ann', targetName: 'Team' } as never);
    const user = userEvent.setup();
    renderAt('/register?invite=tok-1');
    await user.click(await googleButton());
    cleanup();

    renderAt(`/register?googleError=cancelled&next=${encodeURIComponent('/decision?token=tok-1')}`);
    await waitFor(() => expect(readLocation(screen.getByTestId('location')).params.get('invite')).toBe('tok-1'));
    expect(authApi.invitation).toHaveBeenLastCalledWith('tok-1');
  });
});

describe('returning from Google with an error', () => {
  it.each(ERRORS.flatMap(([reason, key]) => [['login', reason, key], ['register', reason, key]] as const))(
    'the %s page shows googleError=%s as %s and clears it from the address',
    async (page, reason, key) => {
      const next = '/decision?token=abc';
      renderAt(`/${page}?googleError=${reason}&next=${encodeURIComponent(next)}`);
      expect(await screen.findByText(english(key))).toBeInTheDocument();
      await waitFor(() => expect(readLocation(screen.getByTestId('location')).params.has('googleError')).toBe(false));
      const { pathname, params } = readLocation(screen.getByTestId('location'));
      expect(pathname).toBe(`/${page}`);
      expect(params.get('next')).toBe(next);
      expect(authApi.me).not.toHaveBeenCalled();
      expect(useCurrentUserStore.getState().user).toBeNull();
      expect(await googleButton()).toBeEnabled();
    },
  );
});
