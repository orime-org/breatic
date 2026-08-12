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

  it('shows the account itself, not just its name', async () => {
    // Acceptance item 1 asks for the avatar in the MENU. The trigger has one
    // too, but that one is present whether the menu is open or not — it is the
    // button, not the identity block. A header that names an account without
    // showing its face is the thing this item exists to prevent, and reading
    // the menu's text cannot tell the two apart, which is how it slipped
    // through the first time.
    const user = userEvent.setup();
    useCurrentUserStore.getState().setUser(ALEX);
    setup();
    await openMenu(user);

    const menu = screen.getByRole('menu');
    // StudioAvatar renders the initial when there is no image; either way it
    // is an element of its own inside the menu, not text on the label.
    expect(
      menu.querySelector('[data-testid="account-menu-avatar"]'),
    ).not.toBeNull();
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
    // The name is the account's own, so it takes the foreground; the label
    // wrapping it is muted, and a name that does not say otherwise inherits
    // that and paints identically to the handle beneath it.
    const name = screen.getByText('Alex');
    expect(name.className).toContain('text-foreground');
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
      // `data-disabled` is what Radix stamps when the `disabled` PROP is
      // passed; its absence is the assertion that carries weight here. (There
      // is no point checking for an HTML `disabled` attribute: the item is a
      // div, which cannot carry one, so that check can never fail.)
      expect(entry).not.toHaveAttribute('data-disabled');
    },
  );

  it.each([['Credits'], ['Membership']])(
    'shows %s where focus is, not only to the machine',
    async (name) => {
      // Reachable and invisible is the same outcome as unreachable for the
      // person looking at the screen: they arrow down, nothing appears to
      // happen, and the entry reads as skipped. The menu primitive expresses
      // its highlight as a background, so an entry left with no background to
      // show has no way of saying where focus is.
      const user = userEvent.setup();
      useCurrentUserStore.getState().setUser(ALEX);
      setup();
      await openMenu(user);

      const entry = screen.getByRole('menuitem', { name: new RegExp(name) });
      // The row must not dim ITSELF. `opacity` composites the whole element
      // against its backdrop, background included, so a dimmed row dims its own
      // highlight: at 50% over the primitive's accent that is a five-level step
      // out of 255, which is no indicator at all. The row is then focusable and
      // invisible — the outcome the `disabled` attribute was rejected for. The
      // dimming belongs on the content.
      expect(entry.className).not.toMatch(/(^|\s)opacity-/);
      // Something still fills on focus, and it is not nothing. The shared
      // `focus:bg-accent` is deliberately traded for a `focus-visible:` one —
      // pointer-move focus must not light a row that cannot be pressed — so
      // what this insists on is that the trade left a highlight behind.
      expect(entry.className).toMatch(/focus(-visible)?:bg-(?!transparent)/);
      // The dimming is on the content instead.
      const dimmed = entry.querySelector('[class*="opacity-"]');
      expect(dimmed).not.toBeNull();
      expect(dimmed?.textContent).toContain(name);
    },
  );

  it.each([['Credits'], ['Membership']])(
    'dims %s as ONE thing — the note included',
    async (name) => {
      // Every disabled thing in this product dims the whole element and lets
      // the tokens inside keep their own order: the toolbar's disabled sort
      // button dims "Sort" and "Recently opened" together and the first stays
      // the quieter of the two; the unavailable Timeline card dims its icon,
      // title, subtitle and badge together. Leaving the note outside the dim
      // is what made it the loudest thing on a row whose whole point is the
      // feature's NAME.
      const user = userEvent.setup();
      useCurrentUserStore.getState().setUser(ALEX);
      setup();
      await openMenu(user);

      const entry = screen.getByRole('menuitem', { name: new RegExp(name) });
      const dimmed = entry.querySelector('[class*="opacity-"]');
      expect(dimmed).not.toBeNull();
      expect(dimmed?.textContent).toContain(name);
      expect(dimmed?.textContent).toContain('Not open yet');
      // Nothing readable is left outside it.
      expect(entry.textContent).toBe(dimmed?.textContent);
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

      // Exact: every address this menu can reach starts with `/studio`, so a
      // substring assertion would hold whatever the entry did.
      expect(screen.getByTestId('location').textContent).toBe('/studio');
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
