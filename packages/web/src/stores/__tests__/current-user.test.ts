// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import { useCurrentUserStore, toCurrentUser } from '@web/stores/current-user';

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
      personalStudio: { name: 'Alice', slug: 'alice', avatarUrl: null },
      membershipTier: 'base',
    });
    useCurrentUserStore.getState().setRole('owner');
    const s = useCurrentUserStore.getState();
    expect(s.user?.id).toBe('u1');
    expect(s.user?.personalStudio).toEqual({
      name: 'Alice',
      slug: 'alice',
      avatarUrl: null,
    });
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
      membershipTier: 'base',
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
      personalStudio: { name: 'x', slug: 'xhandle', avatarUrl: null },
      membershipTier: 'base',
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

  it('carries the membership tier from the auth response onto the store user', () => {
    // 头像菜单显示档位，它读的就是这个字段。这个投影是唯一的写入口
    // （引导、登录、注册三处都走它），漏掉字段的话三处一起漏。
    const user = toCurrentUser({
      id: 'u3',
      email: 'c@d.com',
      personalStudio: { name: 'Carol', slug: 'carol', avatarUrl: null },
      membershipTier: 'pro',
    });

    expect(user.membershipTier).toBe('pro');
  });

  it('carries a tier that has no ceilings in configuration', () => {
    // 企业版的上限一家一谈、配置里没有，但档位本身照常显示。
    const user = toCurrentUser({
      id: 'u4',
      email: 'e@f.com',
      personalStudio: null,
      membershipTier: 'enterprise',
    });

    expect(user.membershipTier).toBe('enterprise');
  });
});
