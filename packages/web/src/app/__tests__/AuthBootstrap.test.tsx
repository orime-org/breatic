import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

import AuthBootstrap from '@/app/AuthBootstrap';
import { authApi } from '@/data/api/auth';
import { useCurrentUserStore } from '@/stores';

vi.mock('@/data/api/auth', () => ({
  authApi: { me: vi.fn() },
}));

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

  it('200 OK populates user + flips bootstrapped=true', async () => {
    vi.mocked(authApi.me).mockResolvedValueOnce({
      id: 'u1',
      email: 'a@b.com',
      name: 'Alice',
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
