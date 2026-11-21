// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Google sign-in inside the desktop client (#1599).
 *
 * Google refuses sign-in in an embedded page, so the client's button opens the
 * system browser and waits. The browser hands a code back to the client; the
 * page takes it, trades it for a session through our own API and finishes the
 * sign-in like the browser does. The page may reload or move between the login
 * and register pages while it waits, so it asks the client on mount whether a
 * sign-in is waiting and whether its result has arrived.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { BrowserSignInResult, DesktopBridge } from '@breatic/shared';

import { authApi } from '@web/data/api/auth';
import { DesktopGoogleSignIn } from '@web/pages/auth/DesktopGoogleSignIn';
import { useCurrentUserStore } from '@web/stores';
import { toast } from '@web/lib/toast';

vi.mock('@web/data/api/auth', async () => {
  const actual = await vi.importActual<typeof import('@web/data/api/auth')>('@web/data/api/auth');
  return { ...actual, authApi: { desktopExchange: vi.fn() } };
});
vi.mock('@web/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@web/i18n/locale-bootstrap', () => ({ changeLocale: vi.fn(async () => undefined) }));

/** A bridge whose answers a test sets, recording what the page asked. */
function fakeBridge(state: { pending?: boolean; result?: BrowserSignInResult | null } = {}) {
  const listeners = new Set<() => void>();
  let pending = state.pending ?? false;
  let result = state.result ?? null;
  const bridge = {
    platform: 'darwin',
    signInWithBrowser: vi.fn(async () => { pending = true; }),
    cancelBrowserSignIn: vi.fn(async () => { pending = false; result = null; }),
    isBrowserSignInPending: vi.fn(async () => pending),
    takeBrowserSignInResult: vi.fn(async () => { const taken = result; result = null; pending = false; return taken; }),
    onBrowserSignInResult: vi.fn((listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }),
  } satisfies DesktopBridge;
  /** Deliver a result the way the client does: store it, then notify. */
  const arrive = (next: BrowserSignInResult): void => {
    result = next;
    for (const listener of listeners) listener();
  };
  return { bridge, arrive };
}

const user = {
  id: 'u1',
  email: 'ada@example.com',
  locale: 'en',
  membershipTier: 'free',
  personalStudio: { id: 's1', slug: 'ada', name: 'Ada', avatarUrl: null },
};

/**
 * Render the button on a login route with the destination it goes to.
 * @param referralCode - The code the page carries.
 */
function setup(referralCode: string | null = null) {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path='/login' element={<DesktopGoogleSignIn referralCode={referralCode} next='/studio/ada' busy={false} />} />
        <Route path='/studio/ada' element={<div data-testid='destination' />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useCurrentUserStore.setState({ user: null, role: null, loading: false, bootstrapped: true });
});

afterEach(() => {
  delete (window as { breaticDesktop?: DesktopBridge }).breaticDesktop;
});

describe('DesktopGoogleSignIn', () => {
  it('opens the browser with the carried referral code and waits', async () => {
    const { bridge } = fakeBridge();
    (window as { breaticDesktop?: DesktopBridge }).breaticDesktop = bridge;
    setup('FRIEND1');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Continue with Google' }));
    expect(bridge.signInWithBrowser).toHaveBeenCalledWith('FRIEND1');
    expect(await screen.findByText('Finish signing in in your browser')).toBeInTheDocument();
  });

  it('cancels the wait', async () => {
    const { bridge } = fakeBridge({ pending: true });
    (window as { breaticDesktop?: DesktopBridge }).breaticDesktop = bridge;
    setup();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(bridge.cancelBrowserSignIn).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  });

  it('resumes the wait after the page reloads', async () => {
    const { bridge } = fakeBridge({ pending: true });
    (window as { breaticDesktop?: DesktopBridge }).breaticDesktop = bridge;
    setup();
    expect(await screen.findByText('Finish signing in in your browser')).toBeInTheDocument();
  });

  it('trades an arriving code for a session and finishes the sign-in', async () => {
    const { bridge, arrive } = fakeBridge({ pending: true });
    (window as { breaticDesktop?: DesktopBridge }).breaticDesktop = bridge;
    vi.mocked(authApi.desktopExchange).mockResolvedValue({ user } as never);
    setup();
    await screen.findByText('Finish signing in in your browser');
    arrive({ code: 'c'.repeat(43), verifier: 'v'.repeat(43) });
    expect(await screen.findByTestId('destination')).toBeInTheDocument();
    expect(authApi.desktopExchange).toHaveBeenCalledWith({ code: 'c'.repeat(43), verifier: 'v'.repeat(43) });
    expect(useCurrentUserStore.getState().user?.id).toBe('u1');
  });

  it('takes a result that arrived before the page mounted', async () => {
    const { bridge } = fakeBridge({ pending: true, result: { code: 'c'.repeat(43), verifier: 'v'.repeat(43) } });
    (window as { breaticDesktop?: DesktopBridge }).breaticDesktop = bridge;
    vi.mocked(authApi.desktopExchange).mockResolvedValue({ user } as never);
    setup();
    expect(await screen.findByTestId('destination')).toBeInTheDocument();
  });

  it('says the sign-in did not finish when the trade is refused', async () => {
    const { bridge, arrive } = fakeBridge({ pending: true });
    (window as { breaticDesktop?: DesktopBridge }).breaticDesktop = bridge;
    vi.mocked(authApi.desktopExchange).mockRejectedValue(new Error('401'));
    setup();
    await screen.findByText('Finish signing in in your browser');
    arrive({ code: 'c'.repeat(43), verifier: 'v'.repeat(43) });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Sign-in did not finish. Try again.'));
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeEnabled();
    expect(useCurrentUserStore.getState().user).toBeNull();
  });

  it('drops the wait when the page leaves signed in', async () => {
    const { bridge } = fakeBridge({ pending: true });
    (window as { breaticDesktop?: DesktopBridge }).breaticDesktop = bridge;
    const { unmount } = setup();
    await screen.findByText('Finish signing in in your browser');
    useCurrentUserStore.setState({ user: { id: 'u2' } as never });
    unmount();
    expect(bridge.cancelBrowserSignIn).toHaveBeenCalled();
  });

  it('keeps the wait when the page leaves signed out', async () => {
    const { bridge } = fakeBridge({ pending: true });
    (window as { breaticDesktop?: DesktopBridge }).breaticDesktop = bridge;
    const { unmount } = setup();
    await screen.findByText('Finish signing in in your browser');
    unmount();
    expect(bridge.cancelBrowserSignIn).not.toHaveBeenCalled();
  });
});
