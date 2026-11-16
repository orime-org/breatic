// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

import type { ProjectUser } from '@web/data/yjs/project-meta';
import { useFollowStore } from '@web/stores/follow';

/** What the project page tells the leader presence check. */
export interface FollowLeaderPresenceInput {
  /** The project's presence records. */
  users: readonly ProjectUser[];
  /** The project roster: each member's display name by user id. */
  memberNames: ReadonlyMap<string, string>;
  /** Whether both the presence records and the roster have loaded. */
  synced: boolean;
  /** This user's id, or null before it is known. */
  currentUserId: string | null;
  /** Whom the followed member's picked view says they follow, or null. */
  leaderFollowing: string | null;
}

/**
 * Stop following when the leader goes offline, leaves the project, or starts
 * following someone (#920): following is one level deep. A leader following
 * someone who is neither this user nor on the roster counts as following
 * nobody. Nothing is judged before the records have loaded, when everyone
 * reads as absent.
 * @param input - The current presence and roster; see `FollowLeaderPresenceInput`.
 */
export function useFollowLeaderPresence(input: FollowLeaderPresenceInput): void {
  const { users, memberNames, synced, currentUserId, leaderFollowing } = input;
  const targetUserId = useFollowStore((s) => s.targetUserId);
  React.useEffect(() => {
    if (targetUserId === null || !synced) return;
    const offline = users.some((u) => u.id === targetUserId && !u.online);
    if (offline || !memberNames.has(targetUserId)) {
      useFollowStore.getState().stop('offline');
      return;
    }
    if (leaderFollowing === null) return;
    if (leaderFollowing === currentUserId) {
      useFollowStore.getState().stop('leaderFollows', 'you');
      return;
    }
    const otherName = memberNames.get(leaderFollowing);
    if (otherName !== undefined) useFollowStore.getState().stop('leaderFollows', { name: otherName });
  }, [targetUserId, users, memberNames, synced, currentUserId, leaderFollowing]);
}
