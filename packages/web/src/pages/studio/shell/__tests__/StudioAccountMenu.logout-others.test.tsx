// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * "Sign out of other devices" in the account menu (inner#1548).
 *
 * The approved menu reads: account settings | membership, credits | cookie
 * settings, sign out of other devices | sign out. Choosing it asks first; the
 * confirm button waits on the request, success closes the dialog with a toast,
 * failure keeps it open with a toast. This device stays signed in.
 *
 * Cookie settings is shown by a deployment that measures anything, so this
 * file turns it on; the menu without it is pinned in StudioAccountMenu.test.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { authApi } from '@web/data/api/auth';
import { StudioAccountMenu } from '@web/pages/studio/shell/StudioAccountMenu';
import { useCurrentUserStore } from '@web/stores/current-user';

vi.mock('@web/data/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/analytics')>()),
  COOKIE_SETTINGS_AVAILABLE: true,
  openCookieSettings: vi.fn(),
}));

vi.mock('@web/data/api/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/auth')>()),
  authApi: { logout: vi.fn(), logoutOthers: vi.fn(), me: vi.fn(() => Promise.reject(new Error('not stubbed'))) },
}));

vi.mock('@web/data/api/account', () => ({
  accountApi: { membership: vi.fn(() => new Promise(() => {})) },
}));

vi.mock('@web/data/api/credits', () => ({
  fetchCreditOverview: vi.fn(() => new Promise(() => {})),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('@web/lib/toast', () => ({ toast: toastMock }));

const ALEX = {
  id: 'u1',
  name: 'Alex',
  email: 'alex@x.example',
  personalStudio: { name: 'Alex', slug: 'alex', avatarUrl: null },
  membershipTier: 'base' as const,
};

/**
 * Render the menu.
 * @returns The render result.
 */
function setup(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <MemoryRouter initialEntries={['/studio']}>
      <QueryClientProvider client={qc}>
        <StudioAccountMenu />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/**
 * Open the menu and choose "Sign out of other devices".
 * @param user - The userEvent session.
 * @returns The confirm dialog.
 */
async function chooseLogoutOthers(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'Account' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Sign out of other devices' }));
  return screen.findByRole('alertdialog');
}

describe('StudioAccountMenu — sign out of other devices', () => {
  beforeEach(() => {
    useCurrentUserStore.getState().clear();
    useCurrentUserStore.getState().setUser(ALEX);
    vi.mocked(authApi.logoutOthers).mockReset();
    vi.mocked(authApi.logout).mockReset();
    for (const fn of Object.values(toastMock)) fn.mockReset();
  });

  it('sits with cookie settings, below credits and above sign out', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    const menu = await screen.findByRole('menu');

    const rows = [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((el) =>
      el.getAttribute('role') === 'separator' ? '|' : (el.textContent ?? '').trim(),
    );
    const at = (label: string): number => rows.findIndex((row) => row.startsWith(label));
    const cookie = at('Cookie settings');
    const others = at('Sign out of other devices');
    const signOut = rows.findIndex((row) => row === 'Sign out');

    expect(cookie).toBeGreaterThan(at('Credits'));
    expect(others).toBe(cookie + 1);
    expect(rows[cookie - 1]).toBe('|');
    expect(rows[others + 1]).toBe('|');
    expect(signOut).toBe(others + 2);
  });

  it('asks before signing anything out', async () => {
    const user = userEvent.setup();
    setup();
    const dialog = await chooseLogoutOthers(user);

    expect(within(dialog).getByText('Sign out of other devices?')).toBeInTheDocument();
    expect(authApi.logoutOthers).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(authApi.logoutOthers).not.toHaveBeenCalled();
  });

  it('hands focus back to the account button when it closes', async () => {
    // Opened from a menu entry that is gone by then, so without this focus
    // lands on the page body and a keyboard reader starts over from the top.
    const user = userEvent.setup();
    setup();
    await chooseLogoutOthers(user);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Account' })).toHaveFocus();
  });

  it('waits on the request, then closes and says it is done; this device stays signed in', async () => {
    let answer: () => void = () => {};
    vi.mocked(authApi.logoutOthers).mockReturnValue(new Promise<void>((resolve) => { answer = resolve; }));
    const user = userEvent.setup();
    setup();
    const dialog = await chooseLogoutOthers(user);
    const confirm = within(dialog).getByRole('button', { name: 'Sign out of other devices' });

    await user.click(confirm);
    expect(authApi.logoutOthers).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    await user.click(confirm);
    expect(authApi.logoutOthers).toHaveBeenCalledTimes(1);

    answer();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(toastMock.success).toHaveBeenCalledWith('Signed out of your other devices');
    expect(authApi.logout).not.toHaveBeenCalled();
    expect(useCurrentUserStore.getState().user).not.toBeNull();
  });

  it('stays open and says so when it fails', async () => {
    vi.mocked(authApi.logoutOthers).mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();
    setup();
    const dialog = await chooseLogoutOthers(user);
    const confirm = within(dialog).getByRole('button', { name: 'Sign out of other devices' });

    await user.click(confirm);

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(confirm).not.toHaveAttribute('aria-busy');
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
