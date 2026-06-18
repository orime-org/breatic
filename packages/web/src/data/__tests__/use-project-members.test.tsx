// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The member roster is split across two endpoints by design (v10 §7.2.6):
// `membersApi.list` returns the role relation only, `usersApi.getByIds`
// returns the profiles. The hook fetches both and merges into the `Member`
// shape consumed by MembersStack. Mock both API surfaces.
vi.mock('@web/data/api/members', () => ({
  membersApi: { list: vi.fn() },
}));
vi.mock('@web/data/api/users', () => ({
  usersApi: { getByIds: vi.fn() },
}));

import { membersApi } from '@web/data/api/members';
import { usersApi } from '@web/data/api/users';
import { useProjectMembers } from '@web/data/use-project-members';

/**
 * QueryClientProvider wrapper for the hook under test.
 * @param client - The QueryClient backing the rendered hook.
 * @returns A wrapper component injecting the QueryClient context.
 */
function makeWrapper(
  client: QueryClient,
): (props: { children: React.ReactNode }) => React.JSX.Element {
  return function Wrapper({
    children,
  }: {
    children: React.ReactNode;
  }): React.JSX.Element {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

/**
 * Fresh QueryClient with retries off so rejected mocks fail fast in tests.
 * @returns A QueryClient with query retries disabled.
 */
function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useProjectMembers (#1375: real two-endpoint member merge)', () => {
  it('merges role relation + profiles into the Member shape', async () => {
    vi.mocked(membersApi.list).mockResolvedValue([
      { userId: 'u1', role: 'owner' },
      { userId: 'u2', role: 'editor' },
    ]);
    vi.mocked(usersApi.getByIds).mockResolvedValue([
      { id: 'u1', name: 'Alice', email: 'a@x.com' },
      { id: 'u2', name: 'Bob', email: 'b@x.com' },
    ]);

    const { result } = renderHook(() => useProjectMembers('p1'), {
      wrapper: makeWrapper(makeClient()),
    });

    await waitFor(() => {
      expect(result.current.members).toHaveLength(2);
    });

    // Each merged Member uses userId as its id (there is no separate
    // membership id) and carries the profile name/email + relation role.
    expect(result.current.members).toEqual([
      {
        id: 'u1',
        userId: 'u1',
        name: 'Alice',
        email: 'a@x.com',
        role: 'owner',
        avatarUrl: undefined,
      },
      {
        id: 'u2',
        userId: 'u2',
        name: 'Bob',
        email: 'b@x.com',
        role: 'editor',
        avatarUrl: undefined,
      },
    ]);
    // The profile call receives exactly the relation's user ids.
    expect(vi.mocked(usersApi.getByIds)).toHaveBeenCalledWith(['u1', 'u2']);
  });

  it('does not fetch profiles when there are no members', async () => {
    vi.mocked(membersApi.list).mockResolvedValue([]);

    const { result } = renderHook(() => useProjectMembers('p1'), {
      wrapper: makeWrapper(makeClient()),
    });

    // Roles resolve to an empty array → no user ids → profile query stays
    // disabled and the merged list is empty.
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.members).toEqual([]);
    expect(vi.mocked(usersApi.getByIds)).not.toHaveBeenCalled();
  });

  it('does not fetch for the demo project (no projectId)', () => {
    renderHook(() => useProjectMembers('demo'), {
      wrapper: makeWrapper(makeClient()),
    });

    // The 'demo' sentinel disables the roster query, so neither endpoint
    // is hit and MembersStack falls back to its own stub.
    expect(vi.mocked(membersApi.list)).not.toHaveBeenCalled();
    expect(vi.mocked(usersApi.getByIds)).not.toHaveBeenCalled();
  });
});
