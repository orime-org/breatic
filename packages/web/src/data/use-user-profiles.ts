// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';

import type { UserSummary } from '@web/data/api/users';
import { usersApi } from '@web/data/api/users';

/** Query key prefix; the full key appends the sorted id list. */
const PROFILES_KEY = 'user-profiles-by-id';

/** Nobody to name — a stable identity, so a caller's memo can bail out. */
const NOBODY: ReadonlyMap<string, UserSummary> = new Map();

/**
 * Resolves user ids into names and avatars, straight from the account.
 *
 * Separate from `useProjectMembers` on purpose, and the difference is the
 * whole point of this file. That hook answers "who is on this project", so it
 * intersects the profiles with the roster; anybody who has left drops out of
 * its result. Annotations must not work that way — a note keeps its author's
 * name after they leave the project (#1881 A11), and the roster cannot say
 * what it no longer holds.
 *
 * `GET /users?ids=…` is not scoped to a project: it answers for any id a
 * signed-in caller asks about, up to 100 at a time, and omits only accounts
 * that have been soft-deleted. That omission is the one remaining fallback,
 * and the caller renders it as "we do not know who".
 *
 * The ids are sorted and de-duplicated before they reach the key, so two
 * stickies naming the same two people share one cache entry and one request
 * rather than each waiting on its own.
 * @param userIds - The ids to resolve; repeats and order do not matter.
 * @returns The profiles that came back, keyed by id — empty while in flight,
 *   and empty for anybody the endpoint did not answer for.
 */
export function useUserProfiles(
  userIds: readonly string[],
): ReadonlyMap<string, UserSummary> {
  const ids = React.useMemo(
    () => [...new Set(userIds)].sort(),
    // The array identity changes on every render at most call sites, so the
    // memo keys on its contents instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userIds.join(',')],
  );

  const query = useQuery({
    queryKey: [PROFILES_KEY, ids],
    queryFn: () => usersApi.getByIds(ids),
    enabled: ids.length > 0,
    // Keep the names already on screen while a newly named person loads.
    // The id list is part of the key, so one reply from somebody new makes
    // this a different query with an empty cache — and every other author,
    // whose profile did not change, would go nameless until the request
    // lands. Same reasoning as the roster's own profile query.
    placeholderData: (previous) => previous,
    // Against the app's default, which is off. Off suits data a user can
    // ask for again — reopen the panel, press the button. There is no asking
    // for this one: it is the only request behind every name on a board, so
    // one failure takes them all at once and leaves nothing that would fetch
    // them again. Coming back to the tab is the cheapest moment to retry.
    refetchOnWindowFocus: true,
  });

  return React.useMemo(() => {
    const rows = query.data;
    if (rows === undefined || rows.length === 0) return NOBODY;
    return new Map(rows.map((row) => [row.id, row]));
  }, [query.data]);
}
