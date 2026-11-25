// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';

import { useFollowStore, type FollowOther } from '@web/stores/follow';

/** What the project page tells the leader presence check. */
export interface FollowLeaderPresenceInput {
  /** The members online in this project now. */
  onlineUserIds: ReadonlySet<string>;
  /** The project roster: each member's display name by user id. */
  memberNames: ReadonlyMap<string, string>;
  /** Whether both the presence records and the roster have loaded. */
  synced: boolean;
  /** Whom the followed member follows here, or null for nobody. */
  leaderFollows: FollowOther | null;
}

/**
 * Stop following when the leader goes offline, leaves the project, or starts
 * following someone (#920): following is one level deep. Nothing is judged
 * before the records have loaded, when everyone reads as absent.
 * @param input - The current presence and roster; see `FollowLeaderPresenceInput`.
 */
export function useFollowLeaderPresence(input: FollowLeaderPresenceInput): void {
  const { onlineUserIds, memberNames, synced, leaderFollows } = input;
  const targetUserId = useFollowStore((s) => s.targetUserId);
  React.useEffect(() => {
    if (targetUserId === null || !synced) return;
    if (!onlineUserIds.has(targetUserId) || !memberNames.has(targetUserId)) {
      useFollowStore.getState().stop('offline');
      return;
    }
    if (leaderFollows !== null) useFollowStore.getState().stop('leaderFollows', leaderFollows);
  }, [targetUserId, onlineUserIds, memberNames, synced, leaderFollows]);
}
