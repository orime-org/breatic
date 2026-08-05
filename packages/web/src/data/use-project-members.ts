// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import type { Member } from '@web/data/api/members';
import { membersApi } from '@web/data/api/members';
import { usersApi } from '@web/data/api/users';

/** Query key of the role relation half of the roster. */
const ROLES_KEY = 'project-members';
/** Query key prefix of the profile half (the full key appends the id list). */
const PROFILES_KEY = 'user-profiles';

interface ProjectMembersResult {
  members: Member[];
  isLoading: boolean;
}

/**
 * Loads the real project-member roster for the top-bar MembersStack.
 *
 * The roster is split across two endpoints by design (v10 §7.2.6):
 *   - `GET /projects/:id/members` returns the ROLE RELATION only
 *     (`{ userId, role }`) — no name/email.
 *   - `GET /users?ids=…` returns the PROFILES (`{ id, name, email, avatarUrl }`).
 *
 * This hook fetches both and merges them into the `Member` shape MembersStack
 * consumes, keying each merged row on `userId` (there is no separate
 * membership id). The profile query stays disabled until the relation
 * resolves with at least one user id, so a project with no members never
 * hits `/users`. The `'demo'` sentinel disables the whole roster so the
 * stub fallback in MembersStack stands in.
 * @param projectId - The bare project uuid (or `'demo'` to disable fetching).
 * @returns The merged members (empty until both queries resolve) and a loading flag.
 */
export function useProjectMembers(projectId: string): ProjectMembersResult {
  const rolesQuery = useQuery({
    queryKey: [ROLES_KEY, projectId],
    queryFn: () => membersApi.list(projectId),
    enabled: projectId !== 'demo',
  });

  const userIds = React.useMemo(
    () => (rolesQuery.data ?? []).map((m) => m.userId),
    [rolesQuery.data],
  );

  const profilesQuery = useQuery({
    queryKey: [PROFILES_KEY, projectId, userIds],
    queryFn: () => usersApi.getByIds(userIds),
    enabled: userIds.length > 0,
  });

  // Memoised because consumers put this array — or something derived from it —
  // into dependency lists. Rebuilding it on every render is what silently
  // destroyed and recreated the open canvas text-node editor: the roster
  // travels down to `useEditor`, which compares its deps by identity and
  // rebuilds the whole editor on any mismatch, discarding the selection and
  // undo stack of whoever was typing. The rows only change when one of the two
  // queries resolves, so that is what this depends on.
  const members: Member[] = React.useMemo(() => {
    const profiles = profilesQuery.data ?? [];
    return (rolesQuery.data ?? []).map((row) => {
      const profile = profiles.find((p) => p.id === row.userId);
      return {
        id: row.userId,
        userId: row.userId,
        name: profile?.name ?? '',
        email: profile?.email ?? '',
        role: row.role,
        avatarUrl: profile?.avatarUrl,
      };
    });
  }, [rolesQuery.data, profilesQuery.data]);

  const isLoading =
    rolesQuery.isLoading || (userIds.length > 0 && profilesQuery.isLoading);

  return { members, isLoading };
}

/**
 * Re-fetch the whole roster for a project.
 *
 * BOTH halves, always. Invalidating only the roles query looks sufficient
 * because a membership change alters the id list, which changes the profile
 * query's key and re-fetches it as a side effect — but when an existing member
 * simply comes back online the ids are identical, so the profile query (where
 * names and avatars live) would never move. Whoever adds a third query to this
 * roster has to add it here too; that is why the keys are constants in this
 * file rather than string literals at each callsite.
 * @param client - The query client holding the roster cache.
 * @param projectId - The project whose roster to refresh.
 */
export function refetchProjectRoster(
  client: QueryClient,
  projectId: string,
): void {
  void client.invalidateQueries({ queryKey: [ROLES_KEY, projectId] });
  // Prefix match: the full key appends the id list, and every cached id list
  // for this project is stale for the same reason.
  void client.invalidateQueries({ queryKey: [PROFILES_KEY, projectId] });
}

/**
 * Re-fetch the roster whenever anyone joins the project's online set.
 *
 * Unconditional by design (owner, #1882): no filtering on whether the id is
 * already known, no skipping ourselves, no debounce. Each of those is a
 * judgement about who is worth re-fetching for, and the one that was proposed
 * — "only when the id is missing from the roster" — would have quietly kept
 * showing the old name for anyone the roster already listed, which is most of
 * the renames this is here to catch.
 *
 * A departure is not a join and brings no new identity to resolve, so it does
 * not trigger. Membership is compared by content, not by reference: awareness
 * hands out a fresh Set on every heartbeat.
 * @param projectId - The project whose roster to refresh.
 * @param onlineUserIds - The user ids currently online, from awareness.
 */
export function useRosterRefreshOnJoin(
  projectId: string,
  onlineUserIds: ReadonlySet<string>,
): void {
  const client = useQueryClient();
  const seenRef = React.useRef<ReadonlySet<string>>(onlineUserIds);

  React.useEffect(() => {
    const seen = seenRef.current;
    seenRef.current = onlineUserIds;
    for (const id of onlineUserIds) {
      if (!seen.has(id)) {
        refetchProjectRoster(client, projectId);
        return;
      }
    }
  }, [client, projectId, onlineUserIds]);
}
