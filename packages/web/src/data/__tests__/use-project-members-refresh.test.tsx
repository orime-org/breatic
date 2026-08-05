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
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

import {
  refetchProjectRoster,
  useRosterRefreshOnJoin,
} from '@web/data/use-project-members';

const PROJECT = 'p1';

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

describe('refetchProjectRoster', () => {
  let client: QueryClient;
  let invalidate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    invalidate = vi.fn().mockResolvedValue(undefined);
    client.invalidateQueries = invalidate;
  });

  it('re-fetches BOTH halves of the roster, not just the roles', () => {
    refetchProjectRoster(client, PROJECT);
    const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey?.[0]);
    expect(keys).toContain('project-members');
    expect(keys).toContain('user-profiles');
  });

  it('scopes the profile refresh to this project, not to every project open', () => {
    refetchProjectRoster(client, PROJECT);
    const profiles = invalidate.mock.calls.find(
      (c) => c[0]?.queryKey?.[0] === 'user-profiles',
    );
    // The profile key is ['user-profiles', projectId, userIds]; matching on
    // the first two segments hits every id list this project has cached
    // without touching another project's.
    expect(profiles?.[0]?.queryKey).toEqual(['user-profiles', PROJECT]);
  });
});

describe('useRosterRefreshOnJoin', () => {
  let client: QueryClient;
  let invalidate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    invalidate = vi.fn().mockResolvedValue(undefined);
    client.invalidateQueries = invalidate;
  });

  it('re-fetches when a user id joins the online set', () => {
    const { rerender } = renderHook(
      ({ online }: { online: ReadonlySet<string> }) =>
        useRosterRefreshOnJoin(PROJECT, online),
      {
        initialProps: { online: new Set(['a']) as ReadonlySet<string> },
        wrapper: wrapper(client),
      },
    );
    invalidate.mockClear();

    rerender({ online: new Set(['a', 'b']) as ReadonlySet<string> });
    expect(invalidate).toHaveBeenCalled();
  });

  it('does not re-fetch when somebody merely leaves', () => {
    // Leaving brings no new identity to resolve. This is not a condition on
    // WHO we re-fetch for — it is that a departure is not a join at all.
    const { rerender } = renderHook(
      ({ online }: { online: ReadonlySet<string> }) =>
        useRosterRefreshOnJoin(PROJECT, online),
      {
        initialProps: { online: new Set(['a', 'b']) as ReadonlySet<string> },
        wrapper: wrapper(client),
      },
    );
    invalidate.mockClear();

    rerender({ online: new Set(['a']) as ReadonlySet<string> });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('re-fetches for a returning member the roster already lists', () => {
    // The rejected alternative ("only when the id is unknown") would skip this
    // one, and a rename made while they were away would never show up.
    const { rerender } = renderHook(
      ({ online }: { online: ReadonlySet<string> }) =>
        useRosterRefreshOnJoin(PROJECT, online),
      {
        initialProps: { online: new Set(['a', 'b']) as ReadonlySet<string> },
        wrapper: wrapper(client),
      },
    );
    rerender({ online: new Set(['a']) as ReadonlySet<string> });
    invalidate.mockClear();

    rerender({ online: new Set(['a', 'b']) as ReadonlySet<string> });
    expect(invalidate).toHaveBeenCalled();
  });

  it('does not re-fetch when the set is rebuilt with the same members', () => {
    // Awareness hands out a fresh Set on every heartbeat; re-fetching on
    // identity rather than on content would hammer the endpoint.
    const { rerender } = renderHook(
      ({ online }: { online: ReadonlySet<string> }) =>
        useRosterRefreshOnJoin(PROJECT, online),
      {
        initialProps: { online: new Set(['a', 'b']) as ReadonlySet<string> },
        wrapper: wrapper(client),
      },
    );
    invalidate.mockClear();

    rerender({ online: new Set(['b', 'a']) as ReadonlySet<string> });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
