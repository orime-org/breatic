// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * When somebody announces they came online, this client re-fetches the roster.
 *
 * That is the whole rule, and it is deliberately unconditional (#1882, owner):
 * no "only if the id is unknown", no skipping ourselves, no debounce. A
 * condition would be a judgement about who is worth re-fetching for, and every
 * such judgement is a place to be wrong — the one that was proposed and
 * rejected ("only when the id is missing from the roster") would have silently
 * kept showing a stale name for anyone already listed.
 *
 * The roster is two queries stitched together, and BOTH have to be re-fetched.
 * Invalidating only the roles query looks like it works: when membership
 * actually changed, the ids change, the profile query's key changes with them
 * and it re-fetches on its own. But when an EXISTING member simply comes back
 * online the ids are identical, the profile key is identical, and the profiles
 * — which is where names and avatars live — never move.
 *
 * These tests run against a REAL query client with real cache entries, and
 * assert on the cache. Replacing `invalidateQueries` with a spy would only
 * prove that a call was made with certain arguments — it would stay green
 * through key shapes that match nothing, which is the way this can actually
 * break.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

import { membersApi } from '@web/data/api/members';
import { usersApi } from '@web/data/api/users';
import {
  refetchProjectRoster,
  useProjectMembers,
  useRosterRefreshOnJoin,
} from '@web/data/use-project-members';

vi.mock('@web/data/api/members', () => ({
  membersApi: { list: vi.fn() },
}));
vi.mock('@web/data/api/users', () => ({
  usersApi: { getByIds: vi.fn() },
}));

const PROJECT = 'p1';
const ROLES_KEY = ['project-members', PROJECT];
const PROFILES_KEY = ['user-profiles', PROJECT, ['a']];
/** Another project's profile cache — must survive a refresh of ours. */
const OTHER_PROFILES_KEY = ['user-profiles', 'p2', ['z']];

/** Wrap a hook in a provider carrying the given client. */
function wrapper(client: QueryClient) {
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
 * Put real entries in the cache so there is something to invalidate.
 * @param client - The client to seed.
 */
function seedRoster(client: QueryClient): void {
  client.setQueryData(ROLES_KEY, [{ userId: 'a', role: 'editor' }]);
  client.setQueryData(PROFILES_KEY, [
    { id: 'a', name: 'Old Name', email: 'a@x.com' },
  ]);
  client.setQueryData(OTHER_PROFILES_KEY, []);
}

/**
 * Whether the cache entry behind a key is marked for re-fetch.
 * @param client - The client holding the cache.
 * @param key - The full query key.
 * @returns True when that entry will re-fetch.
 */
function isInvalidated(client: QueryClient, key: unknown[]): boolean {
  return client.getQueryState(key)?.isInvalidated === true;
}

describe('refetchProjectRoster', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    seedRoster(client);
  });

  it('really invalidates BOTH halves of the roster, not just the roles', () => {
    expect(isInvalidated(client, ROLES_KEY)).toBe(false);
    expect(isInvalidated(client, PROFILES_KEY)).toBe(false);

    refetchProjectRoster(client, PROJECT);

    expect(isInvalidated(client, ROLES_KEY)).toBe(true);
    expect(isInvalidated(client, PROFILES_KEY)).toBe(true);
  });

  it('reaches the profile entry through its id-list suffix', () => {
    // The profile key is ['user-profiles', projectId, userIds]. A refresh that
    // demanded an exact match would find nothing and quietly change no state —
    // the failure this whole test file exists to catch.
    refetchProjectRoster(client, PROJECT);
    expect(isInvalidated(client, PROFILES_KEY)).toBe(true);
  });

  it('leaves another project’s cached profiles alone', () => {
    refetchProjectRoster(client, PROJECT);
    expect(isInvalidated(client, OTHER_PROFILES_KEY)).toBe(false);
  });
});

describe('useRosterRefreshOnJoin', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    seedRoster(client);
  });

  /** Render the hook with an initial online set. */
  function mount(online: ReadonlySet<string>) {
    return renderHook(
      ({ ids }: { ids: ReadonlySet<string> }) =>
        useRosterRefreshOnJoin(PROJECT, ids),
      { initialProps: { ids: online }, wrapper: wrapper(client) },
    );
  }

  it('re-fetches when a user id joins the online set', () => {
    const { rerender } = mount(new Set(['a']));
    expect(isInvalidated(client, PROFILES_KEY)).toBe(false);

    rerender({ ids: new Set(['a', 'b']) as ReadonlySet<string> });
    expect(isInvalidated(client, PROFILES_KEY)).toBe(true);
  });

  it('does not re-fetch when somebody merely leaves', () => {
    // Leaving brings no new identity to resolve. This is not a condition on
    // WHO we re-fetch for — it is that a departure is not a join at all.
    const { rerender } = mount(new Set(['a', 'b']));

    rerender({ ids: new Set(['a']) as ReadonlySet<string> });
    expect(isInvalidated(client, PROFILES_KEY)).toBe(false);
  });

  it('re-fetches for a returning member the roster already lists', () => {
    // The rejected alternative ("only when the id is unknown") would skip this
    // one, and a rename made while they were away would never show up.
    const { rerender } = mount(new Set(['a', 'b']));
    rerender({ ids: new Set(['a']) as ReadonlySet<string> });
    expect(isInvalidated(client, PROFILES_KEY)).toBe(false);

    rerender({ ids: new Set(['a', 'b']) as ReadonlySet<string> });
    expect(isInvalidated(client, PROFILES_KEY)).toBe(true);
  });

  it('does not re-fetch when the set is rebuilt with the same members', () => {
    // Awareness hands out a fresh Set on every heartbeat; re-fetching on
    // identity rather than on content would hammer the endpoint.
    const { rerender } = mount(new Set(['a', 'b']));

    rerender({ ids: new Set(['b', 'a']) as ReadonlySet<string> });
    expect(isInvalidated(client, PROFILES_KEY)).toBe(false);
  });
});

describe('useProjectMembers', () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.mocked(membersApi.list).mockResolvedValue([
      { userId: 'a', role: 'editor' },
    ] as Awaited<ReturnType<typeof membersApi.list>>);
    vi.mocked(usersApi.getByIds).mockResolvedValue([
      { id: 'a', name: 'Alice', email: 'a@x.com' },
    ] as Awaited<ReturnType<typeof usersApi.getByIds>>);
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  it('hands back the SAME roster array until the data behind it changes', async () => {
    // Consumers put this array — or a bundle wrapping it — into dependency
    // lists. Rebuilding it per render destroyed and recreated the open canvas
    // text-node editor, throwing away the selection and undo stack of whoever
    // was typing. Reference stability here is the fix at its source.
    const { result, rerender } = renderHook(
      () => useProjectMembers(PROJECT),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => expect(result.current.members).toHaveLength(1));
    const first = result.current.members;
    expect(first[0]?.name).toBe('Alice');

    rerender();
    expect(result.current.members).toBe(first);
    rerender();
    expect(result.current.members).toBe(first);
  });
});
