// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { AuthUser } from '@web/data/api/auth';
import {
  refreshCurrentUser,
  toCurrentUser,
  useCurrentUserStore,
} from '@web/stores/current-user';

const meMock = vi.fn();
vi.mock('@web/data/api/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/auth')>()),
  authApi: { me: () => meMock() },
}));

/**
 * An account as `/auth/me` answers it.
 * @param id - Which account.
 * @param membershipTier - The tier it is on.
 * @returns The answer.
 */
function account(id: string, membershipTier: AuthUser['membershipTier']): AuthUser {
  return {
    id,
    email: `${id}@x.example`,
    personalStudio: { name: id, slug: id, avatarUrl: null },
    membershipTier,
  } as AuthUser;
}

/**
 * A `/auth/me` that answers only when told to, so the store can change in
 * between the way it does when somebody signs out while the read is out.
 * @returns The trigger that lets it answer.
 */
function heldAnswer(): (answer: AuthUser) => void {
  let release: (answer: AuthUser) => void = () => {};
  meMock.mockImplementationOnce(
    () =>
      new Promise<AuthUser>((resolve) => {
        release = resolve;
      }),
  );
  return (answer) => release(answer);
}

describe('refreshCurrentUser', () => {
  beforeEach(() => {
    meMock.mockReset();
    useCurrentUserStore.getState().clear();
  });

  it('writes the fresh answer over the same account', async () => {
    useCurrentUserStore.getState().setUser(toCurrentUser(account('u1', 'base')));
    meMock.mockResolvedValue(account('u1', 'pro'));

    await refreshCurrentUser();

    expect(useCurrentUserStore.getState().user?.membershipTier).toBe('pro');
  });

  it('leaves a signed-out store signed out when the answer lands late', async () => {
    useCurrentUserStore.getState().setUser(toCurrentUser(account('u1', 'base')));
    const answer = heldAnswer();
    const pending = refreshCurrentUser();

    useCurrentUserStore.getState().clear();
    answer(account('u1', 'pro'));
    await pending;

    expect(useCurrentUserStore.getState().user).toBeNull();
  });

  it('leaves the next account alone when an answer about the last one lands late', async () => {
    useCurrentUserStore.getState().setUser(toCurrentUser(account('u1', 'base')));
    const answer = heldAnswer();
    const pending = refreshCurrentUser();

    useCurrentUserStore.getState().setUser(toCurrentUser(account('u2', 'team')));
    answer(account('u1', 'pro'));
    await pending;

    expect(useCurrentUserStore.getState().user?.id).toBe('u2');
    expect(useCurrentUserStore.getState().user?.membershipTier).toBe('team');
  });
});
