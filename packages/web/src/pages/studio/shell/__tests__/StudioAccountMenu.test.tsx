// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';

import { authApi } from '@web/data/api/auth';
import { StudioAccountMenu } from '@web/pages/studio/shell/StudioAccountMenu';
import { useCurrentUserStore } from '@web/stores/current-user';

vi.mock('@web/data/api/auth', () => ({
  authApi: { logout: vi.fn() },
}));

const ALEX = {
  id: 'u1',
  name: 'Alex',
  email: 'alex@x.example',
  personalStudio: { name: 'Alex', slug: 'alex', avatarUrl: null },
};

/**
 * Report the current path so a test can assert where a menu entry took the
 * user — the menu navigates, and the destination is the thing under test.
 * @returns An element carrying the current pathname.
 */
function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid='location'>{location.pathname}</div>;
}

/**
 * Render the menu inside a router, so entries that navigate can be followed.
 * @returns The render result.
 */
function setup(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/studio']}>
      <StudioAccountMenu />
      <LocationProbe />
    </MemoryRouter>,
  );
}

/**
 * Open the menu, the way a user does.
 * @param user - The userEvent session driving the interaction.
 */
async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Account' }));
  await screen.findByRole('menu');
}

describe('StudioAccountMenu', () => {
  beforeEach(() => {
    useCurrentUserStore.getState().clear();
    vi.mocked(authApi.logout).mockReset().mockResolvedValue(undefined);
  });

  it('shows the current user initial on the avatar button', () => {
    useCurrentUserStore.getState().setUser(ALEX);
    setup();
    expect(screen.getByRole('button', { name: 'Account' })).toHaveTextContent(
      'A',
    );
  });

  it('names who is signed in, by display name and handle', async () => {
    // The handle is the personal studio's slug — the identifier other people
    // use to find this account — so seeing it is the point, not decoration.
    const user = userEvent.setup();
    useCurrentUserStore.getState().setUser(ALEX);
    setup();
    await openMenu(user);

    const menu = screen.getByRole('menu');
    expect(menu).toHaveTextContent('Alex');
    expect(menu).toHaveTextContent('@alex');
  });

  it.each([
    ['Credits', 'Credits'],
    ['Membership', 'Membership'],
  ])(
    'offers %s, marked unavailable in a way that still reaches the keyboard',
    async (_label, name) => {
      // These two entries exist to be FOUND — the feature behind each one is
      // not built, and showing them is how a user learns it is coming. The
      // HTML `disabled` attribute would take them out of the tab order, so
      // the one audience that navigates by moving focus would never meet
      // them. `aria-disabled` says the same thing and stays reachable.
      const user = userEvent.setup();
      useCurrentUserStore.getState().setUser(ALEX);
      setup();
      await openMenu(user);

      const entry = screen.getByRole('menuitem', { name: new RegExp(name) });
      expect(entry).toHaveAttribute('aria-disabled', 'true');
      expect(entry).not.toHaveAttribute('disabled');
      expect(entry).not.toHaveAttribute('data-disabled');
    },
  );

  it.each([['Credits'], ['Membership']])(
    'does nothing at all when %s is chosen',
    async (name) => {
      // Reachable is not the same as actionable: the entry must answer the
      // keyboard, and then decline. A menu that closes on the press would
      // read as "something happened" when nothing did.
      const user = userEvent.setup();
      useCurrentUserStore.getState().setUser(ALEX);
      setup();
      await openMenu(user);

      await user.click(screen.getByRole('menuitem', { name: new RegExp(name) }));

      expect(screen.getByTestId('location')).toHaveTextContent('/studio');
      expect(screen.getByRole('menu')).toBeInTheDocument();
    },
  );

  it('takes account settings to the personal studio settings tab', async () => {
    // A personal studio's settings ARE the account's: the avatar and the
    // handle are edited there, so the menu points at that tab rather than at
    // a second settings page that would hold the same two fields.
    const user = userEvent.setup();
    useCurrentUserStore.getState().setUser(ALEX);
    setup();
    await openMenu(user);

    await user.click(
      screen.getByRole('menuitem', { name: 'Account settings' }),
    );

    expect(screen.getByTestId('location')).toHaveTextContent(
      '/studio/alex/settings',
    );
  });

  it('closes itself once account settings is chosen', async () => {
    // The top bar is mounted by the layout route, so navigating swaps only
    // the content below it — nothing unmounts this menu. Left to itself it
    // would sit open on top of the page it just sent the user to.
    const user = userEvent.setup();
    useCurrentUserStore.getState().setUser(ALEX);
    setup();
    await openMenu(user);

    await user.click(
      screen.getByRole('menuitem', { name: 'Account settings' }),
    );

    await waitFor(() =>
      expect(screen.queryByRole('menu')).not.toBeInTheDocument(),
    );
  });

  it('signs out — calls the logout API then clears the user', async () => {
    const user = userEvent.setup();
    useCurrentUserStore.getState().setUser(ALEX);
    setup();
    await openMenu(user);

    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    expect(authApi.logout).toHaveBeenCalledTimes(1);
    // Clearing the local user is what drives ProtectedRoute to /login.
    await waitFor(() =>
      expect(useCurrentUserStore.getState().user).toBeNull(),
    );
  });
});
