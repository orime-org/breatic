// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Signing in has to put the user's REAL display name in the store.
 *
 * This is the client half of #1882's first root cause. The login response
 * never carried the personal studio at all, so the display name fell back to
 * the email prefix from the very first render — a name nobody chose, wrong
 * before anything could go stale. The server half is fixed and asserted at
 * all five auth exits; this is the half that decides whether the fix reaches
 * anything the user sees.
 *
 * The whole page had no test file, so the callsite could be reverted to the
 * email-prefix fallback and nothing would notice. The store assertions below
 * use a studio name that is NOT derivable from the email, so a regression to
 * any fallback fails rather than coincidentally matching.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { authApi } from '@web/data/api/auth';
import LoginPage from '@web/pages/auth/LoginPage';
import { useCurrentUserStore } from '@web/stores';

// Mock only the network call; the projection into the store stays real.
vi.mock('@web/data/api/auth', async () => {
  const actual = await vi.importActual<typeof import('@web/data/api/auth')>(
    '@web/data/api/auth',
  );
  return { ...actual, authApi: { login: vi.fn() } };
});

/** Render the login route with the destinations it can navigate to. */
function setup() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path='/login' element={<LoginPage />} />
        <Route path='/studio' element={<div data-testid='studio-page' />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Fill the form and submit it. */
async function signIn(): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Email'), 'ada@example.com');
  await user.type(screen.getByLabelText('Password'), 'correct-horse');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCurrentUserStore.setState({
      user: null,
      role: null,
      loading: false,
      bootstrapped: true,
    });
  });

  it('stores the display name from the personal studio, not the email', async () => {
    vi.mocked(authApi.login).mockResolvedValue({
      user: {
        id: 'u-ada',
        email: 'ada@example.com',
        personalStudio: {
          name: 'Ada Lovelace',
          slug: 'ada-l',
          avatarUrl: 'https://cdn.example/ada.png',
        },
      },
    } as Awaited<ReturnType<typeof authApi.login>>);

    setup();
    await signIn();

    await waitFor(() =>
      expect(useCurrentUserStore.getState().user?.name).toBe('Ada Lovelace'),
    );
    const stored = useCurrentUserStore.getState().user;
    expect(stored?.avatarUrl).toBe('https://cdn.example/ada.png');
    expect(stored?.personalStudio?.slug).toBe('ada-l');
  });

  it('falls back to the email prefix only when there is no studio yet', async () => {
    // A user who registered but has not picked a slug. There is genuinely no
    // display name to show, so the prefix is the honest answer — and the
    // onboarding gate reads the null to route them to slug setup.
    vi.mocked(authApi.login).mockResolvedValue({
      user: { id: 'u-new', email: 'newcomer@example.com', personalStudio: null },
    } as Awaited<ReturnType<typeof authApi.login>>);

    setup();
    await signIn();

    await waitFor(() =>
      expect(useCurrentUserStore.getState().user?.name).toBe('newcomer'),
    );
    expect(useCurrentUserStore.getState().user?.personalStudio).toBeNull();
  });

  it('leaves the avatar unset rather than blank when the studio has none', async () => {
    // The avatar component picks between the image and the initials fallback
    // on this value, and an empty string reads as a present-but-broken source.
    vi.mocked(authApi.login).mockResolvedValue({
      user: {
        id: 'u-ada',
        email: 'ada@example.com',
        personalStudio: { name: 'Ada', slug: 'ada', avatarUrl: null },
      },
    } as Awaited<ReturnType<typeof authApi.login>>);

    setup();
    await signIn();

    await waitFor(() =>
      expect(useCurrentUserStore.getState().user?.name).toBe('Ada'),
    );
    expect(useCurrentUserStore.getState().user?.avatarUrl).toBeUndefined();
  });
});
