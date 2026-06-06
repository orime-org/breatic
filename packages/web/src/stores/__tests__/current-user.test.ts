// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import { useCurrentUserStore } from '@web/stores/current-user';

describe('useCurrentUserStore', () => {
  beforeEach(() => {
    useCurrentUserStore.getState().clear();
  });

  it('initial state is fully empty (no token field after cookie migration)', () => {
    const s = useCurrentUserStore.getState();
    expect(s.user).toBeNull();
    expect(s.role).toBeNull();
    expect(s.loading).toBe(false);
    // bootstrapped=false on first boot lets ProtectedRoute show a
    // loading shell instead of immediately bouncing to /login while
    // the AuthBootstrap `/auth/me` ping is still in flight.
    expect(s.bootstrapped).toBe(false);
    // Token used to live on the store; the cookie migration moved
    // it to an httpOnly cookie that JS cannot read. Pin the absence
    // of `token` here so any future regression reintroducing it
    // (and the XSS exfiltration surface that came with it) trips
    // this test before review.
    expect('token' in s).toBe(false);
    expect('setToken' in s).toBe(false);
  });

  it('setUser + setRole populate fields (incl. personalStudio)', () => {
    useCurrentUserStore.getState().setUser({
      id: 'u1',
      name: 'Alice',
      email: 'a@b.com',
      personalStudio: { name: 'Alice', slug: 'alice' },
    });
    useCurrentUserStore.getState().setRole('owner');
    const s = useCurrentUserStore.getState();
    expect(s.user?.id).toBe('u1');
    expect(s.user?.personalStudio).toEqual({ name: 'Alice', slug: 'alice' });
    expect(s.role).toBe('owner');
  });

  it('setUser stores a null personalStudio (the onboarding-incomplete state)', () => {
    // The two-step registration gap: account exists, slug not yet
    // picked. ProtectedRoute reads this null as the onboarding gate.
    useCurrentUserStore.getState().setUser({
      id: 'u2',
      name: 'bob',
      email: 'bob@b.com',
      personalStudio: null,
    });
    expect(useCurrentUserStore.getState().user?.personalStudio).toBeNull();
  });

  it('setBootstrapped flips the flag without touching user/role', () => {
    useCurrentUserStore.getState().setBootstrapped(true);
    const s = useCurrentUserStore.getState();
    expect(s.bootstrapped).toBe(true);
    // bootstrapped completion is independent of authentication outcome:
    // a 401 on /auth/me must still flip bootstrapped=true (user stays
    // null) so ProtectedRoute knows the boot ping completed and can
    // safely bounce to /login.
    expect(s.user).toBeNull();
  });

  it('clear resets user/role but keeps bootstrapped=true (logout is not a re-boot)', () => {
    useCurrentUserStore.getState().setUser({
      id: 'u',
      name: 'x',
      email: 'x@y',
      personalStudio: { name: 'x', slug: 'xhandle' },
    });
    useCurrentUserStore.getState().setRole('owner');
    useCurrentUserStore.getState().setBootstrapped(true);
    useCurrentUserStore.getState().clear();
    const s = useCurrentUserStore.getState();
    expect(s.user).toBeNull();
    expect(s.role).toBeNull();
    // Explicit logout / 401 mid-session: the bootstrap ping already
    // completed, the unauthenticated state is the final ground truth.
    // Resetting bootstrapped=false here would re-trigger the loading
    // shell on the next route render — a flash, not a recovery.
    expect(s.bootstrapped).toBe(true);
  });
});
