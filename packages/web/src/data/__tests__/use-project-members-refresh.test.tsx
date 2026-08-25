// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * When somebody's `online` flag turns true, this client re-fetches the roster.
 *
 * The flag lives on the server-written presence record in the project's meta
 * document, so false-to-true is the server saying it is holding a connection
 * for that person again. That transition is the whole rule, and it is
 * deliberately unconditional (#1882, owner):
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
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

import { membersApi } from '@web/data/api/members';
import { usersApi } from '@web/data/api/users';
import {
  refetchProjectRoster,
  useProjectMembers,
  useRosterRefreshOnJoin,
} from '@web/data/use-project-members';
import type { ProjectUser } from '@web/data/yjs/project-meta';

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

  /**
   * Build the presence map the server writes, from `id → online`.
   * @param flags - Who has a record, and whether it says online.
   * @returns The map the hook consumes.
   */
  function presence(
    flags: Record<string, boolean>,
  ): ReadonlyMap<string, ProjectUser> {
    return new Map(
      Object.entries(flags).map(([id, online]) => [
        id,
        { id, online, lastSeenAt: 1_000 },
      ]),
    );
  }

  /** Render the hook with an initial presence map. */
  function mount(users: ReadonlyMap<string, ProjectUser>) {
    return renderHook(
      ({ u }: { u: ReadonlyMap<string, ProjectUser> }) =>
        useRosterRefreshOnJoin(PROJECT, u),
      { initialProps: { u: users }, wrapper: wrapper(client) },
    );
  }

  it('re-fetches when a record first appears saying online', () => {
    const { rerender } = mount(presence({ a: true }));
    expect(isInvalidated(client, PROFILES_KEY)).toBe(false);

    rerender({ u: presence({ a: true, b: true }) });
    expect(isInvalidated(client, PROFILES_KEY)).toBe(true);
  });

  it('re-fetches when an existing record flips from offline to online', () => {
    // The server never deletes a record; it flips the flag. So a returning
    // person arrives as false-to-true on a row that was there all along, and
    // a hook watching only for NEW ids would miss every return.
    const { rerender } = mount(presence({ a: true, b: false }));
    expect(isInvalidated(client, PROFILES_KEY)).toBe(false);

    rerender({ u: presence({ a: true, b: true }) });
    expect(isInvalidated(client, PROFILES_KEY)).toBe(true);
  });

  it('does not re-fetch when somebody merely goes offline', () => {
    // Leaving brings no new identity to resolve. This is not a condition on
    // WHO we re-fetch for — it is that a departure is not an arrival at all.
    const { rerender } = mount(presence({ a: true, b: true }));

    rerender({ u: presence({ a: true, b: false }) });
    expect(isInvalidated(client, PROFILES_KEY)).toBe(false);
  });

  it('does not re-fetch for a record that appears already offline', () => {
    // A first sync hands over everyone who has ever been in this project,
    // most of them offline. None of those is an arrival.
    const { rerender } = mount(presence({ a: true }));

    rerender({ u: presence({ a: true, b: false }) });
    expect(isInvalidated(client, PROFILES_KEY)).toBe(false);
  });

  it('does not re-fetch when the map is rebuilt with the same flags', () => {
    // A fresh Map arrives on every heartbeat, since the timestamp inside every
    // record moves. Re-fetching on identity rather than on the flag would hit
    // the endpoint on every heartbeat of every person in the project.
    const { rerender } = mount(presence({ a: true, b: true }));

    rerender({ u: presence({ b: true, a: true }) });
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

  describe('while a new member’s profile is still loading', () => {
    /**
     * Settle a two-person roster, then add a third and hold the profile
     * request open so the in-flight window can be inspected.
     * @param client - The query client to render against.
     * @returns The hook result and a release function for the held request.
     */
    async function joinWithHeldProfiles(client: QueryClient): Promise<{
      names: () => (string | undefined)[];
      release: () => void;
    }> {
      vi.mocked(membersApi.list).mockResolvedValue([
        { userId: 'a', role: 'owner' },
        { userId: 'b', role: 'editor' },
      ] as Awaited<ReturnType<typeof membersApi.list>>);
      vi.mocked(usersApi.getByIds).mockImplementation((async (ids: string[]) =>
        ids.map((id) => ({ id, name: id.toUpperCase(), email: `${id}@x.com` }))) as
        unknown as typeof usersApi.getByIds);

      const { result } = renderHook(() => useProjectMembers(PROJECT), {
        wrapper: wrapper(client),
      });
      await waitFor(() => expect(result.current.members[0]?.name).toBe('A'));

      // Somebody joins. This PR's own refresh-on-join fires here, and the id
      // list is part of the profile query's key, so this is a brand-new query.
      vi.mocked(membersApi.list).mockResolvedValue([
        { userId: 'a', role: 'owner' },
        { userId: 'b', role: 'editor' },
        { userId: 'c', role: 'editor' },
      ] as Awaited<ReturnType<typeof membersApi.list>>);
      let release = (): void => {};
      vi.mocked(usersApi.getByIds).mockImplementation((() =>
        new Promise((resolve) => {
          release = (): void => resolve([]);
        })) as unknown as typeof usersApi.getByIds);

      await act(async () => {
        refetchProjectRoster(client, PROJECT);
        await new Promise((r) => setTimeout(r, 30));
      });

      return {
        names: () => result.current.members.map((m) => m.name),
        release: () => release(),
      };
    }

    it('keeps the names of the people we already knew', async () => {
      // The bug this pins: one person joining wiped the name off every member,
      // including everyone whose profile had not changed at all. On screen that
      // is every remote caret losing its label for a round trip — collaborators
      // turning into anonymous coloured lines because somebody else arrived.
      const { names, release } = await joinWithHeldProfiles(client);
      expect(names()).toContain('A');
      expect(names()).toContain('B');
      release();
    });

    it('still reports the newcomer as unknown until their profile lands', async () => {
      // The other half, and the one a careless fix breaks: we genuinely do not
      // know this person's name yet. An empty name is the honest answer, and it
      // is what makes their caret render as a bare line rather than a label
      // with something invented in it.
      const { names, release } = await joinWithHeldProfiles(client);
      expect(names()).toHaveLength(3);
      expect(names()[2]).toBe('');
      release();
    });
  });
});
