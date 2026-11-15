// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

import type { ProjectUser } from '@web/data/yjs/project-meta';
import { useFollowStore } from '@web/stores/follow';

/** What the project page tells the leader presence check. */
export interface FollowLeaderPresenceInput {
  /** The project's presence records. */
  users: readonly ProjectUser[];
  /** The user ids on the project roster. */
  memberUserIds: readonly string[];
  /** Whether both the presence records and the roster have loaded. */
  synced: boolean;
}

/**
 * Stop following when the leader goes offline or leaves the project (#920).
 * Nothing is judged before the records have loaded, when everyone reads as
 * absent.
 * @param input - The current presence and roster; see `FollowLeaderPresenceInput`.
 */
export function useFollowLeaderPresence(input: FollowLeaderPresenceInput): void {
  const { users, memberUserIds, synced } = input;
  const targetUserId = useFollowStore((s) => s.targetUserId);
  React.useEffect(() => {
    if (targetUserId === null || !synced) return;
    const offline = users.some((u) => u.id === targetUserId && !u.online);
    if (offline || !memberUserIds.includes(targetUserId)) useFollowStore.getState().stop('offline');
  }, [targetUserId, users, memberUserIds, synced]);
}
