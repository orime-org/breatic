// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
});
