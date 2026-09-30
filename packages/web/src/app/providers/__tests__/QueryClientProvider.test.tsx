// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';

import { QueryClientProvider, queryClient } from '@web/app/providers/QueryClientProvider';
import {
  useCurrentUserStore,
  type CurrentUser,
} from '@web/stores/current-user';

/**
 * A store user with the given id. Only the id matters here — it is what the
 * cache is scoped to.
 * @param id - The account id.
 * @returns The store shape.
 */
function accountNamed(id: string): CurrentUser {
  return {
    id,
    name: id,
    email: `${id}@example.test`,
    personalStudio: { name: id, slug: id, avatarUrl: null },
    membershipTier: 'base',
  };
}

describe('QueryClientProvider — the cache belongs to one account (#271)', () => {
  beforeEach(() => {
    queryClient.clear();
    act(() => {
      useCurrentUserStore.getState().clear();
    });
  });

  it('drops what the previous account read when somebody else signs in', () => {
    act(() => {
      useCurrentUserStore.getState().setUser(accountNamed('a'));
    });
    render(
      <QueryClientProvider>
        <div />
      </QueryClientProvider>,
    );
    queryClient.setQueryData(['studios', 'user'], ['a-studio']);

    act(() => {
      useCurrentUserStore.getState().clear();
    });
    act(() => {
      useCurrentUserStore.getState().setUser(accountNamed('b'));
    });

    expect(queryClient.getQueryData(['studios', 'user'])).toBeUndefined();
  });

  it('drops it on the sign-out itself, before anyone else signs in', () => {
    act(() => {
      useCurrentUserStore.getState().setUser(accountNamed('a'));
    });
    render(
      <QueryClientProvider>
        <div />
      </QueryClientProvider>,
    );
    queryClient.setQueryData(['studios', 'recent'], ['a-project']);

    act(() => {
      useCurrentUserStore.getState().clear();
    });

    expect(queryClient.getQueryData(['studios', 'recent'])).toBeUndefined();
  });

  it('drops it when one account replaces another with no sign-out between', () => {
    act(() => {
      useCurrentUserStore.getState().setUser(accountNamed('a'));
    });
    render(
      <QueryClientProvider>
        <div />
      </QueryClientProvider>,
    );
    queryClient.setQueryData(['studio', 'a-studio'], { name: 'a' });

    act(() => {
      useCurrentUserStore.getState().setUser(accountNamed('b'));
    });

    expect(queryClient.getQueryData(['studio', 'a-studio'])).toBeUndefined();
  });

  it('keeps what the boot fetched when the first account of the load arrives', () => {
    render(
      <QueryClientProvider>
        <div />
      </QueryClientProvider>,
    );
    queryClient.setQueryData(['studios', 'user'], ['fetched-during-boot']);

    act(() => {
      useCurrentUserStore.getState().setUser(accountNamed('a'));
    });

    expect(queryClient.getQueryData(['studios', 'user'])).toEqual([
      'fetched-during-boot',
    ]);
  });

  it('keeps it while the same account stays signed in', () => {
    act(() => {
      useCurrentUserStore.getState().setUser(accountNamed('a'));
    });
    render(
      <QueryClientProvider>
        <div />
      </QueryClientProvider>,
    );
    queryClient.setQueryData(['studios', 'user'], ['a-studio']);

    // A rename re-writes the store with the same id.
    act(() => {
      useCurrentUserStore
        .getState()
        .setUser({ ...accountNamed('a'), name: 'renamed' });
    });

    expect(queryClient.getQueryData(['studios', 'user'])).toEqual(['a-studio']);
  });
});
