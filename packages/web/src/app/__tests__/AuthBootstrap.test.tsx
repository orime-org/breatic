// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

import AuthBootstrap from '@web/app/AuthBootstrap';
import { authApi } from '@web/data/api/auth';
import { useCurrentUserStore } from '@web/stores';

// `vi.mock` replaces the WHOLE module — when AuthBootstrap also
// pulls `deriveDisplayName` from the same module, omitting it from
// the factory makes the import resolve to `undefined`, which then
// throws inside the `.then` and silently lands in the `.catch` —
// `setUser` never runs and tests see `user?.id === undefined`. Use
// `importActual` to keep `deriveDisplayName` real while still
// mocking the network-touching `authApi.me`.
vi.mock('@web/data/api/auth', async () => {
  const actual = await vi.importActual<typeof import('@web/data/api/auth')>(
    '@web/data/api/auth',
  );
  return {
    ...actual,
    authApi: { me: vi.fn() },
  };
});

describe('AuthBootstrap', () => {
  beforeEach(() => {
    useCurrentUserStore.setState({
      user: null,
      role: null,
      loading: false,
      bootstrapped: false,
    });
    vi.clearAllMocks();
  });

  it('200 OK populates user + personalStudio + flips bootstrapped=true', async () => {
    // Server `/auth/me` returns the user with `personalStudio: { name,
    // slug } | null`. AuthBootstrap projects the studio name into
    // `useCurrentUserStore.user.name` via `deriveDisplayName` (which
    // prefers the personal-studio name) and mirrors the raw
    // `personalStudio` so ProtectedRoute's onboarding gate can read it.
    vi.mocked(authApi.me).mockResolvedValueOnce({
      id: 'u1',
      email: 'a@b.com',
      personalStudio: { name: 'Alice', slug: 'alice' },
      credits: 100,
    });
    render(
      <AuthBootstrap>
        <div data-testid='child' />
      </AuthBootstrap>,
    );
    await waitFor(() =>
      expect(useCurrentUserStore.getState().bootstrapped).toBe(true),
    );
    const s = useCurrentUserStore.getState();
    expect(s.user?.id).toBe('u1');
    expect(s.user?.name).toBe('Alice');
    expect(s.user?.email).toBe('a@b.com');
    expect(s.user?.personalStudio).toEqual({ name: 'Alice', slug: 'alice' });
  });

  it('200 OK with null personalStudio falls back to email local-part and stays gated', async () => {
    // The half-finished registration case: the account exists but the
    // slug step hasn't run, so `personalStudio` is null. The display
    // name falls back to the email local-part, and the null studio is
    // mirrored so ProtectedRoute bounces the user to onboarding rather
    // than rendering the raw UUID as an actor.
    vi.mocked(authApi.me).mockResolvedValueOnce({
      id: 'u2',
      email: 'songxiuxing@gmail.com',
      personalStudio: null,
      credits: 0,
    });
    render(
      <AuthBootstrap>
        <div />
      </AuthBootstrap>,
    );
    await waitFor(() =>
      expect(useCurrentUserStore.getState().bootstrapped).toBe(true),
    );
    const s = useCurrentUserStore.getState();
    expect(s.user?.name).toBe('songxiuxing');
    expect(s.user?.personalStudio).toBeNull();
  });

  it('401 keeps user=null + flips bootstrapped=true (ProtectedRoute handles bounce)', async () => {
    vi.mocked(authApi.me).mockRejectedValueOnce(
      Object.assign(new Error('Unauthorized'), { status: 401 }),
    );
    render(
      <AuthBootstrap>
        <div />
      </AuthBootstrap>,
    );
    await waitFor(() =>
      expect(useCurrentUserStore.getState().bootstrapped).toBe(true),
    );
    expect(useCurrentUserStore.getState().user).toBeNull();
  });

  it('network error also flips bootstrapped=true so the app doesn\'t hang on the loading shell', async () => {
    vi.mocked(authApi.me).mockRejectedValueOnce(new Error('Network down'));
    render(
      <AuthBootstrap>
        <div />
      </AuthBootstrap>,
    );
    await waitFor(() =>
      expect(useCurrentUserStore.getState().bootstrapped).toBe(true),
    );
    expect(useCurrentUserStore.getState().user).toBeNull();
  });

  it('children render unconditionally (the loading shell is ProtectedRoute concern)', () => {
    // /auth/me hangs forever; AuthBootstrap still mounts children so route
    // tree (including unauthenticated pages like /login) can render.
    vi.mocked(authApi.me).mockImplementation(() => new Promise(() => {}));
    const { getByTestId } = render(
      <AuthBootstrap>
        <div data-testid='child' />
      </AuthBootstrap>,
    );
    expect(getByTestId('child')).toBeInTheDocument();
  });
});
