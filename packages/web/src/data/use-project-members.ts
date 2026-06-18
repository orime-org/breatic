// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { useQuery } from '@tanstack/react-query';

import type { Member } from '@web/data/api/members';
import { membersApi } from '@web/data/api/members';
import { usersApi } from '@web/data/api/users';

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
    queryKey: ['project-members', projectId],
    queryFn: () => membersApi.list(projectId),
    enabled: projectId !== 'demo',
  });

  const userIds = (rolesQuery.data ?? []).map((m) => m.userId);

  const profilesQuery = useQuery({
    queryKey: ['user-profiles', projectId, userIds],
    queryFn: () => usersApi.getByIds(userIds),
    enabled: userIds.length > 0,
  });

  const profiles = profilesQuery.data ?? [];
  const members: Member[] = (rolesQuery.data ?? []).map((row) => {
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

  const isLoading =
    rolesQuery.isLoading || (userIds.length > 0 && profilesQuery.isLoading);

  return { members, isLoading };
}
