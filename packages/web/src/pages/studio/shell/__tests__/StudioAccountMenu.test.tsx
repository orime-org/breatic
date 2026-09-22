// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { CreditOverview } from '@breatic/shared';

import { authApi } from '@web/data/api/auth';
import { StudioAccountMenu } from '@web/pages/studio/shell/StudioAccountMenu';
import { useCurrentUserStore } from '@web/stores/current-user';

vi.mock('@web/data/api/auth', () => ({
  authApi: { logout: vi.fn() },
}));

const membershipMock = vi.fn();
vi.mock('@web/data/api/account', () => ({
  accountApi: { membership: () => membershipMock() },
}));

const overviewMock = vi.fn();
vi.mock('@web/data/api/credits', () => ({
  fetchCreditOverview: () => overviewMock(),
}));

/**
 * What the account holds, as the overview endpoint answers it.
 * @param over - Fields to override.
 * @returns The overview.
 */
function overview(over: Partial<CreditOverview> = {}): CreditOverview {
  return {
    assignedCredits: 3640,
    unassignedCredits: 1790,
    underRefundCredits: 0,
    billing: true,
    studios: [],
    ...over,
  };
}

/**
 * The text to the right of the Credits entry, which is where the balance goes.
 * @returns That text, empty when the entry carries nothing but its own word.
 */
function creditsTrailing(): string {
  const entry = screen.getByRole('menuitem', { name: /Credits/ });
  return (entry.textContent ?? '').replace('Credits', '').trim();
}

const ALEX = {
  id: 'u1',
  name: 'Alex',
  email: 'alex@x.example',
  personalStudio: { name: 'Alex', slug: 'alex', avatarUrl: null },
  membershipTier: 'base' as const,
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
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <MemoryRouter initialEntries={['/studio']}>
      <QueryClientProvider client={qc}>
        <StudioAccountMenu />
        <LocationProbe />
      </QueryClientProvider>
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
    membershipMock.mockReset();
    overviewMock.mockReset().mockResolvedValue(overview());
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

  it('lists the account entries settings first, then membership, then credits', async () => {
    // The order reads from the account outwards: who you are, what you are on,
    // what you have. Nothing enforced it before, so the entries had drifted
    // into the reverse of it and only a person looking at the menu could tell.
    const user = userEvent.setup();
    useCurrentUserStore.getState().setUser(ALEX);
    setup();
    await openMenu(user);

    // Sign out is the fourth and sits below a separator; it is part of the
    // order this asserts, because "last" is where a destructive action belongs.
    const labels = screen
      .getAllByRole('menuitem')
      .map((entry) => entry.textContent ?? '');
    expect(labels).toHaveLength(4);
    expect(labels[0]).toContain('Account settings');
    expect(labels[1]).toContain('Membership');
    expect(labels[2]).toContain('Credits');
    expect(labels[3]).toContain('Sign out');
  });

  it('takes Credits to the credits overlay, over the page below', async () => {
    // 它不再是占位。开的是覆盖层不是页面：查余额是「看一眼」不是「去一趟」，
    // 所以地址栏不动，底下那一层原样留着。
    const user = userEvent.setup();
    useCurrentUserStore.getState().setUser(ALEX);
    setup();
    await openMenu(user);

    await user.click(screen.getByRole('menuitem', { name: /Credits/ }));

    expect(await screen.findByTestId('credits-index')).toBeInTheDocument();
    // 精确比：这个菜单能去的每个地址都以 /studio 开头，子串断言无论它干了
    // 什么都成立。
    expect(screen.getByTestId('location').textContent).toBe('/studio');
  });

  it('marks Credits with the star the balance pill uses', async () => {
    // 顶栏那个余额 pill 已经是这颗星。同一样东西在两处用两个图标，读的人
    // 得自己认出它们说的是一回事。
    const user = userEvent.setup();
    useCurrentUserStore.getState().setUser(ALEX);
    setup();
    await openMenu(user);

    const entry = screen.getByRole('menuitem', { name: /Credits/ });
    expect(entry.querySelector('.lucide-star')).not.toBeNull();
    // 它可以按了，所以既不该说自己不可用，也不该拒绝鼠标。
    expect(entry).not.toHaveAttribute('aria-disabled');
    expect(entry.className).not.toContain('cursor-not-allowed');
  });

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

  it('会员条目直接显示当前档位，而不只是「会员」两个字', async () => {
    // user 2026-08-11：「会员项将直接显示等级，点进去是会员详情」。
    const user = userEvent.setup();
    useCurrentUserStore.getState().setUser({ ...ALEX, membershipTier: 'pro' });
    setup();
    await openMenu(user);

    expect(
      screen.getByRole('menuitem', { name: /Membership/ }),
    ).toHaveTextContent('PRO');
  });

  it('点会员条目在当前页面上打开面板，不导航', async () => {
    // 面板浮在当前 studio 页面上：用户来看会员情况时，他正在做的事不该被
    // 打断，地址栏也始终是底下那个页面的地址。
    const user = userEvent.setup();
    membershipMock.mockReturnValue(new Promise(() => {}));
    useCurrentUserStore.getState().setUser(ALEX);
    setup();
    await openMenu(user);

    await user.click(screen.getByRole('menuitem', { name: /Membership/ }));

    await waitFor(() => {
      expect(screen.getByTestId('membership-skeleton')).toBeInTheDocument();
    });
    expect(screen.getByTestId('location')).toHaveTextContent('/studio');
  });

  it('没打开面板时不去请求会员信息', async () => {
    // 这个菜单挂在每个 studio 页面的顶栏上，而那个接口要把该账号管理的
    // 每个 studio 的资产加总一遍。
    const user = userEvent.setup();
    useCurrentUserStore.getState().setUser(ALEX);
    setup();
    await openMenu(user);

    expect(membershipMock).not.toHaveBeenCalled();
  });

  describe('the balance on the Credits entry', () => {
    it('shows what the account holds, the way the membership tier is shown', async () => {
      const user = userEvent.setup();
      useCurrentUserStore.getState().setUser(ALEX);
      overviewMock.mockResolvedValue(overview());
      setup();
      await openMenu(user);

      // 3640 assigned + 1790 unassigned, grouped the way every other balance
      // on screen is.
      await waitFor(() => {
        expect(creditsTrailing()).toBe('5,430');
      });

      // Same place, same size as the tier on the row above: the two are the
      // things a person opens this menu to check, and one riding higher or
      // heavier than the other makes it look like the more important of them.
      // The last node in the row, so moving the figure to the other side of
      // the word is a failure — `.ml-auto` would still be found there.
      const trailing = (name: RegExp): string => {
        const last = screen.getByRole('menuitem', { name }).lastChild;
        return last instanceof HTMLElement ? last.className : '';
      };
      expect(trailing(/Credits/)).toBe(trailing(/Membership/));
      expect(trailing(/Credits/)).not.toBe('');
    });

    it('counts a pack that is under refund — it is still the buyer’s', async () => {
      // A refund that has been asked for and not settled leaves the credits
      // where they are. Dropping them would make the figure fall the moment a
      // refund is asked about, with nothing on screen saying where they went.
      const user = userEvent.setup();
      useCurrentUserStore.getState().setUser(ALEX);
      overviewMock.mockResolvedValue(overview({ underRefundCredits: 500 }));
      setup();
      await openMenu(user);

      await waitFor(() => {
        expect(creditsTrailing()).toBe('5,930');
      });
    });

    it('holds the place while the figure is still on its way', async () => {
      // A placeholder, because the wait ends by itself and an empty row reads
      // as a balance of nothing. Asserted on the element, since a skeleton
      // carries no text and a missing one would pass a text assertion.
      const user = userEvent.setup();
      useCurrentUserStore.getState().setUser(ALEX);
      overviewMock.mockReturnValue(new Promise(() => {}));
      setup();
      await openMenu(user);

      const row = screen.getByRole('menuitem', { name: /Credits/ });
      expect(row.querySelector('.skeleton-shimmer')).not.toBeNull();
      expect(creditsTrailing()).toBe('');
    });

    it('says so when the read fails, rather than leaving the row blank', async () => {
      // Whether the request lands is not ours to promise; whether the reader
      // knows it did not is. A blank row here reads the same as the one a
      // deployment that does not bill shows.
      const user = userEvent.setup();
      useCurrentUserStore.getState().setUser(ALEX);
      overviewMock.mockRejectedValue(new Error('offline'));
      setup();
      await openMenu(user);

      await waitFor(() => {
        expect(creditsTrailing()).toBe('Unavailable');
      });
    });

    it('keeps one account’s figure away from the next one to sign in', async () => {
      // The query client is a module singleton that a sign-out never clears,
      // so a key without the account would hand the second reader the first
      // one's figures out of cache.
      const user = userEvent.setup();
      // One client across both sign-ins, which is what the app has: it is
      // created once at module scope and outlives every session on this tab.
      const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const show = (): ReturnType<typeof render> =>
        render(
          <MemoryRouter initialEntries={['/studio']}>
            <QueryClientProvider client={qc}>
              <StudioAccountMenu />
            </QueryClientProvider>
          </MemoryRouter>,
        );

      useCurrentUserStore.getState().setUser(ALEX);
      overviewMock.mockResolvedValueOnce(overview());
      const first = show();
      await openMenu(user);
      await waitFor(() => {
        expect(creditsTrailing()).toBe('5,430');
      });

      first.unmount();
      useCurrentUserStore.getState().setUser({ ...ALEX, id: 'u2', name: 'Bo' });
      // Held open, so what the second reader sees is whatever the cache had
      // for them — nothing, unless the key forgot whose money it is.
      let answer: (o: CreditOverview) => void = () => {};
      overviewMock.mockImplementationOnce(
        () =>
          new Promise<CreditOverview>((resolve) => {
            answer = resolve;
          }),
      );
      show();
      await openMenu(user);
      expect(creditsTrailing()).toBe('');

      answer(overview({ assignedCredits: 12, unassignedCredits: 0 }));
      await waitFor(() => {
        expect(creditsTrailing()).toBe('12');
      });
    });

    it('asks for nothing until the menu is opened', () => {
      // This menu is mounted by the studio layout, so every signed-in account
      // reaches it on every page. Without the gate each navigation spends a
      // request on a figure nobody has asked to see.
      useCurrentUserStore.getState().setUser(ALEX);
      setup();
      expect(overviewMock).not.toHaveBeenCalled();
    });

    it('says nothing but the word when a later read fails, not the stale figure', async () => {
      // The menu reads on open, so a reader who opens it twice can have a
      // figure in hand from the first time and a failed read the second. A
      // figure that has gone stale looks exactly like one that is current,
      // and the overlay — reading the same query — is showing its error
      // screen at that moment.
      const user = userEvent.setup();
      useCurrentUserStore.getState().setUser(ALEX);
      overviewMock.mockResolvedValueOnce(overview());
      setup();

      await openMenu(user);
      await waitFor(() => {
        expect(creditsTrailing()).toBe('5,430');
      });

      await user.keyboard('{Escape}');
      overviewMock.mockRejectedValue(new Error('offline'));
      await openMenu(user);
      await waitFor(() => {
        expect(overviewMock).toHaveBeenCalledTimes(2);
      });

      expect(creditsTrailing()).toBe('Unavailable');
    });

    it('says nothing but the word where this deployment does not charge', async () => {
      // Three zeros there mean "we do not bill", not "your money is gone", and
      // rendering the 0 says the second one.
      const user = userEvent.setup();
      useCurrentUserStore.getState().setUser(ALEX);
      overviewMock.mockResolvedValue(
        overview({
          assignedCredits: 0,
          unassignedCredits: 0,
          underRefundCredits: 0,
          billing: false,
        }),
      );
      setup();
      await openMenu(user);

      await waitFor(() => {
        expect(overviewMock).toHaveBeenCalled();
      });
      expect(creditsTrailing()).toBe('');
    });
  });
});
