// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({ setUser: vi.fn() }));
vi.mock('@sentry/react', () => sentry);

import { useCurrentUserStore, type CurrentUser } from '@web/stores/current-user';

const user: CurrentUser = {
  id: 'user-1',
  name: 'Reader',
  email: 'reader@example.test',
  personalStudio: null,
  membershipTier: 'base',
};

beforeEach(() => {
  sentry.setUser.mockClear();
  useCurrentUserStore.setState({ user: null });
});

describe('current user and error monitoring', () => {
  it('attaches only the account id once someone is signed in', () => {
    useCurrentUserStore.getState().setUser(user);
    expect(sentry.setUser).toHaveBeenCalledTimes(1);
    expect(sentry.setUser).toHaveBeenCalledWith({ id: 'user-1' });
  });

  it('detaches the account when the user is set to nobody', () => {
    useCurrentUserStore.getState().setUser(null);
    expect(sentry.setUser).toHaveBeenCalledWith(null);
  });

  it('detaches the account on sign-out', () => {
    useCurrentUserStore.getState().setUser(user);
    useCurrentUserStore.getState().clear();
    expect(sentry.setUser).toHaveBeenLastCalledWith(null);
  });
});
