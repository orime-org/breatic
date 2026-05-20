import { describe, it, expect, beforeEach } from 'vitest';
import { useCurrentUserStore } from '@/stores/current-user';

describe('useCurrentUserStore', () => {
  beforeEach(() => {
    useCurrentUserStore.getState().clear();
  });

  it('initial state is fully empty', () => {
    const s = useCurrentUserStore.getState();
    expect(s.user).toBeNull();
    expect(s.role).toBeNull();
    expect(s.token).toBeNull();
    expect(s.loading).toBe(false);
  });

  it('setUser + setRole + setToken populate fields', () => {
    useCurrentUserStore
      .getState()
      .setUser({ id: 'u1', name: 'Alice', email: 'a@b.com' });
    useCurrentUserStore.getState().setRole('owner');
    useCurrentUserStore.getState().setToken('tk');
    const s = useCurrentUserStore.getState();
    expect(s.user?.id).toBe('u1');
    expect(s.role).toBe('owner');
    expect(s.token).toBe('tk');
  });

  it('clear resets everything', () => {
    useCurrentUserStore
      .getState()
      .setUser({ id: 'u', name: 'x', email: 'x@y' });
    useCurrentUserStore.getState().setToken('tk');
    useCurrentUserStore.getState().clear();
    const s = useCurrentUserStore.getState();
    expect(s.user).toBeNull();
    expect(s.token).toBeNull();
  });
});
