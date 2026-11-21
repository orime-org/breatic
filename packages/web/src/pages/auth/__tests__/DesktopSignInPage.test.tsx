// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The browser page that hands a signed-in account to the desktop client (#1599).
 *
 * The desktop client opens it with a challenge. Asking for a code waits for
 * the user to press Continue: a program could open the page on its own, and
 * the account must not be handed over unless the user asked (RFC 8252 §8.6).
 * The code goes back to the client through `breatic://sign-in`, with the
 * challenge so the client can tell it from a stale one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { authApi } from '@web/data/api/auth';
import { DesktopSignInView } from '@web/pages/auth/DesktopSignInPage';
import { useCurrentUserStore } from '@web/stores';

vi.mock('@web/data/api/auth', async () => {
  const actual = await vi.importActual<typeof import('@web/data/api/auth')>('@web/data/api/auth');
  return { ...actual, authApi: { desktopHandoff: vi.fn(), logout: vi.fn(async () => undefined) } };
});

const CHALLENGE = 'A'.repeat(43);
const open = vi.fn();

/**
 * Render the page at a given query.
 * @param search - The query string.
 */
function setup(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/desktop/sign-in${search}`]}>
      <Routes>
        <Route path='/desktop/sign-in' element={<DesktopSignInView openLink={open} />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(await screen.findByText('Signing in as ada@example.com')).toBeInTheDocument();
    expect(authApi.desktopHandoff).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('hands the code back to the client with the challenge after Continue', async () => {
    vi.mocked(authApi.desktopHandoff).mockResolvedValue({ code: 'C'.repeat(43) });
    setup(`?challenge=${CHALLENGE}`);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Continue' }));
    expect(authApi.desktopHandoff).toHaveBeenCalledWith({ challenge: CHALLENGE });
    expect(open).toHaveBeenCalledWith(`breatic://sign-in?code=${'C'.repeat(43)}&challenge=${CHALLENGE}`);
    expect(await screen.findByText('Back in breatic desktop')).toBeInTheDocument();
  });

  it('opens the same link again from the handed-back page', async () => {
    vi.mocked(authApi.desktopHandoff).mockResolvedValue({ code: 'C'.repeat(43) });
    setup(`?challenge=${CHALLENGE}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Open breatic desktop' }));
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
    expect(await screen.findByText('Signing in as ada@example.com')).toBeInTheDocument();
  });

  it('signs out of the browser to use another account', async () => {
    setup(`?challenge=${CHALLENGE}`);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Use another account' }));
    expect(authApi.logout).toHaveBeenCalled();
    expect(useCurrentUserStore.getState().user).toBeNull();
  });
});
