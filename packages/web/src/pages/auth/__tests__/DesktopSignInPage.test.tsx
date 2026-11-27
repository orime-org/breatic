// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The browser page that hands a signed-in account to the desktop client (inner#2041).
 *
 * The desktop client opens it with a challenge. Asking for a code waits for
 * the user to press Continue: a program could open the page on its own, and
 * the account must not be handed over unless the user asked (RFC 8252 §8.6).
 * The code goes back to the client through `{scheme}://sign-in`, with the
 * challenge so the client can tell it from a stale one. The scheme and the
 * app's name are this deployment's settings from `/auth/options`; nothing in
 * the address can change them, and without them no link is made (design §8.3).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { authApi } from '@web/data/api/auth';
import { DesktopSignInView } from '@web/pages/auth/DesktopSignInPage';
import { useCurrentUserStore } from '@web/stores';

vi.mock('@web/data/api/auth', async () => {
  const actual = await vi.importActual<typeof import('@web/data/api/auth')>('@web/data/api/auth');
  return { ...actual, authApi: { desktopHandoff: vi.fn(), logout: vi.fn(async () => undefined), options: vi.fn() } };
});

const CHALLENGE = 'A'.repeat(43);
const open = vi.fn();

/**
 * Render the page at a given query.
 * @param search - The query string.
 */
function setup(search: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/desktop/sign-in${search}`]}>
        <Routes>
          <Route path='/desktop/sign-in' element={<DesktopSignInView openLink={open} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** This deployment's settings: a partner's desktop app. */
const OPTIONS = { emailVerification: false, referralEnabled: false, desktopAppScheme: 'com.acme.studio', desktopAppName: 'Acme Studio' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authApi.options).mockResolvedValue(OPTIONS);
  useCurrentUserStore.setState({
    user: { id: 'u1', email: 'ada@example.com' } as never,
    role: null,
    loading: false,
    bootstrapped: true,
  });
});

describe('DesktopSignInPage', () => {
  it('asks which account before handing anything over', async () => {
    setup(`?challenge=${CHALLENGE}`);
    // The account is the one thing to check before Continue, so it stands out of its sentence.
    const email = await screen.findByText('ada@example.com');
    expect(email.tagName).toBe('SPAN');
    expect(email.parentElement).toHaveTextContent('Signing in as ada@example.com');
    expect(authApi.desktopHandoff).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('hands the code back to the client with the challenge after Continue', async () => {
    vi.mocked(authApi.desktopHandoff).mockResolvedValue({ code: 'C'.repeat(43) });
    setup(`?challenge=${CHALLENGE}`);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Continue' }));
    expect(authApi.desktopHandoff).toHaveBeenCalledWith({ challenge: CHALLENGE });
    expect(open).toHaveBeenCalledWith(`com.acme.studio://sign-in?code=${'C'.repeat(43)}&challenge=${CHALLENGE}`);
    expect(await screen.findByText('Back in Acme Studio desktop')).toBeInTheDocument();
  });

  it('opens the same link again from the handed-back page', async () => {
    vi.mocked(authApi.desktopHandoff).mockResolvedValue({ code: 'C'.repeat(43) });
    setup(`?challenge=${CHALLENGE}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Open Acme Studio desktop' }));
    expect(open).toHaveBeenCalledTimes(2);
    expect(authApi.desktopHandoff).toHaveBeenCalledTimes(1);
  });

  it('refuses a missing or malformed challenge without asking the server', async () => {
    setup('?challenge=short');
    expect(await screen.findByText('Couldn\'t sign in to the desktop app')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(authApi.desktopHandoff).not.toHaveBeenCalled();
  });

  it('shows the error with a retry when the handoff fails', async () => {
    vi.mocked(authApi.desktopHandoff).mockRejectedValueOnce(new Error('500'));
    setup(`?challenge=${CHALLENGE}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('ada@example.com')).toBeInTheDocument();
  });

  it('signs out of the browser to use another account', async () => {
    setup(`?challenge=${CHALLENGE}`);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Use another account' }));
    expect(authApi.logout).toHaveBeenCalled();
    expect(useCurrentUserStore.getState().user).toBeNull();
  });

  it('names the app the deployment ships, not one the address asks for', async () => {
    setup(`?challenge=${CHALLENGE}&scheme=web%2Bevil&app=Evil`);
    expect(await screen.findByText('Sign in to Acme Studio desktop')).toBeInTheDocument();
    vi.mocked(authApi.desktopHandoff).mockResolvedValue({ code: 'C'.repeat(43) });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Continue' }));
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/^com\.acme\.studio:\/\/sign-in\?/));
  });

  it('cannot continue before the deployment settings arrive', async () => {
    vi.mocked(authApi.options).mockReturnValue(new Promise(() => undefined));
    setup(`?challenge=${CHALLENGE}`);
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('shows the error and builds no link when the deployment settings cannot be read', async () => {
    vi.mocked(authApi.options).mockRejectedValue(new Error('500'));
    setup(`?challenge=${CHALLENGE}`);
    expect(await screen.findByText('Couldn\'t sign in to the desktop app')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(authApi.desktopHandoff).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('reads the deployment settings again from the error card', async () => {
    vi.mocked(authApi.options).mockRejectedValueOnce(new Error('500'));
    setup(`?challenge=${CHALLENGE}`);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeEnabled();
    expect(authApi.options).toHaveBeenCalledTimes(2);
  });
  it('reads the deployment settings again when they named no desktop app', async () => {
    vi.mocked(authApi.options).mockResolvedValueOnce({ emailVerification: false, referralEnabled: false, desktopAppScheme: '', desktopAppName: '' });
    setup(`?challenge=${CHALLENGE}`);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeEnabled();
    expect(authApi.options).toHaveBeenCalledTimes(2);
  });
});
