import { describe, it, expect, beforeEach } from 'vitest';
import { useCurrentUserStore } from '@/stores/current-user';

describe('useCurrentUserStore', () => {
  beforeEach(() => {
    useCurrentUserStore.getState().clear();
  });

  it('initial state is fully empty (no token field after cookie migration)', () => {
    const s = useCurrentUserStore.getState();
    expect(s.user).toBeNull();
    expect(s.role).toBeNull();
    expect(s.loading).toBe(false);
    // Token used to live on the store; the cookie migration moved
    // it to an httpOnly cookie that JS cannot read. Pin the absence
    // of `token` here so any future regression reintroducing it
    // (and the XSS exfiltration surface that came with it) trips
    // this test before review.
    expect('token' in s).toBe(false);
    expect('setToken' in s).toBe(false);
  });

  it('setUser + setRole populate fields', () => {
    useCurrentUserStore
      .getState()
      .setUser({ id: 'u1', name: 'Alice', email: 'a@b.com' });
    useCurrentUserStore.getState().setRole('owner');
    const s = useCurrentUserStore.getState();
    expect(s.user?.id).toBe('u1');
    expect(s.role).toBe('owner');
  });

  it('clear resets everything', () => {
    useCurrentUserStore
      .getState()
      .setUser({ id: 'u', name: 'x', email: 'x@y' });
    useCurrentUserStore.getState().setRole('owner');
    useCurrentUserStore.getState().clear();
    const s = useCurrentUserStore.getState();
    expect(s.user).toBeNull();
    expect(s.role).toBeNull();
  });
});
