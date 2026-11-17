// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "BYOK settings" in the account menu (inner#1953).
 *
 * It sits in the account group, right after account settings and before the promoter program, and opens the BYOK
 * dialog over the page the user is on, the way the promoter program does: no navigation.
 */

import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { AccountReferral } from '@web/data/api/referral';
import { StudioAccountMenu } from '@web/pages/studio/shell/StudioAccountMenu';
import { useCurrentUserStore } from '@web/stores/current-user';

vi.mock('@web/data/api/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/auth')>()),
  authApi: { logout: vi.fn(), me: vi.fn(() => Promise.reject(new Error('not stubbed'))) },
}));

vi.mock('@web/data/api/account', () => ({
  accountApi: { membership: vi.fn(() => new Promise(() => {})) },
}));

vi.mock('@web/data/api/credits', () => ({
  fetchCreditOverview: vi.fn(() => new Promise(() => {})),
}));

const OPEN_PROGRAM: AccountReferral = {
  firstPeriodDiscountPercent: 20,
  binding: null,
  canBind: true,
  program: { open: true, termsVersion: '2026-11-08' },
  promoter: { state: 'none' },
};

vi.mock('@web/data/api/referral', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/referral')>()),
  referralApi: { get: vi.fn(() => Promise.resolve(OPEN_PROGRAM)), bind: vi.fn(), apply: vi.fn() },
}));

// The BYOK dialog reads the account's view through the request helpers; an empty view keeps this file about the
// menu, not the dialog's contents.
const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/request')>()),
  apiGet,
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast: toastMock }));

const ALEX = {
  id: 'u1',
  name: 'Alex',
  email: 'alex@x.example',
  personalStudio: { name: 'Alex', slug: 'alex', avatarUrl: null },
  membershipTier: 'base' as const,
};

/**
 * Report the current path, so a test can tell the menu did not navigate.
 * @returns The pathname.
 */
function LocationProbe(): React.JSX.Element {
  return <div data-testid='location'>{useLocation().pathname}</div>;
}

/**
 * Render the menu on a team Studio's page.
 * @returns The render result.
 */
function setup(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <MemoryRouter initialEntries={['/studio/team-x/projects']}>
      <QueryClientProvider client={qc}>
        <StudioAccountMenu />
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/**
 * Open the menu.
 * @param user - The userEvent session.
 * @returns The menu.
 */
async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'Account' }));
  return screen.findByRole('menu');
}

describe('StudioAccountMenu — BYOK settings (inner#1953)', () => {
  beforeEach(() => {
    useCurrentUserStore.getState().clear();
    useCurrentUserStore.getState().setUser(ALEX);
    apiGet.mockReset().mockImplementation((url: string) =>
      url === '/account/byok'
        ? Promise.resolve({ enabled: true, upstreams: [], keys: [], models: [] })
        : new Promise(() => {}),
    );
    for (const fn of Object.values(toastMock)) fn.mockReset();
  });

  it('sits between account settings and the promoter program', async () => {
    const user = userEvent.setup();
    setup();
    const menu = await openMenu(user);
    await screen.findByRole('menuitem', { name: 'Promoter program' });

    const labels = [...menu.querySelectorAll('[role="menuitem"]')].map((el) => (el.textContent ?? '').trim());
    const settings = labels.findIndex((label) => label.startsWith('Account settings'));
    expect(settings).toBeGreaterThanOrEqual(0);
    expect(labels[settings + 1]).toBe('BYOK settings');
    expect(labels[settings + 2]).toBe('Promoter program');
  });

  it('opens the BYOK dialog over the current page instead of navigating', async () => {
    const user = userEvent.setup();
    setup();
    await openMenu(user);

    await user.click(screen.getByRole('menuitem', { name: 'BYOK settings' }));

    expect(await screen.findByRole('dialog', { name: 'BYOK settings' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/studio/team-x/projects');
    expect(apiGet.mock.calls.map((call) => call[0])).toContain('/account/byok');
  });
});
