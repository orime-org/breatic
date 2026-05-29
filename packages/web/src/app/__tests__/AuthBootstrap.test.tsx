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

  it('200 OK populates user + flips bootstrapped=true (username present)', async () => {
    // Server `/auth/me` returns the canonical `UserEntity` shape —
    // display name lives on `username` (nullable), NOT `name`.
    // AuthBootstrap is expected to project it into
    // `useCurrentUserStore.user.name` via `deriveDisplayName`, which
    // prefers username when set. Earlier mocks used `name: 'Alice'`
    // and the source code read `u.name`, both wrong, producing
    // green-but-meaningless tests while runtime `name` was undefined.
    vi.mocked(authApi.me).mockResolvedValueOnce({
      id: 'u1',
      email: 'a@b.com',
      username: 'Alice',
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
  });

  it('200 OK with null username falls back to email local-part', async () => {
    // Legacy accounts (Google OAuth before username collection
    // landed, Q11 pre-fix users) can have `username = null` in PG.
    // Without a fallback, `currentUser.name` would be empty string
    // and the bell sheet would render the raw UUID as actor.
    vi.mocked(authApi.me).mockResolvedValueOnce({
      id: 'u2',
      email: 'songxiuxing@gmail.com',
      username: null,
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
    expect(useCurrentUserStore.getState().user?.name).toBe('songxiuxing');
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

  it("network error also flips bootstrapped=true so the app doesn't hang on the loading shell", async () => {
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
