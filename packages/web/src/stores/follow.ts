// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which project member this user is following (#920). Whom a user follows is
 * published in the meta awareness `following` (`usePublishView`), so following
 * stays one level deep: nobody follows a member who is following someone.
 */

import { create } from 'zustand';

/**
 * Why following stopped: the stop button, the user moving the viewport or
 * switching the Space themselves, the leader going offline, or the leader
 * starting to follow someone.
 */
export type FollowStopReason = 'button' | 'viewport' | 'space' | 'offline' | 'leaderFollows';

/** Whom the leader started following: this user, or another member by name. */
export type FollowOther = 'you' | { name: string };

/** Every reason but the leader starting to follow, which also names whom. */
type PlainStopReason = Exclude<FollowStopReason, 'leaderFollows'>;

/** What `stop` is told: whom the leader started following comes with `leaderFollows` and only with it. */
type StopArgs = [reason: PlainStopReason] | [reason: 'leaderFollows', other: FollowOther];

/** The last stop, for the one notice it gets; `seq` tells two equal stops apart. */
export type FollowStop = {
  userId: string;
  /** The leader's display name as of the start, kept for a leader who has since left the member list. */
  name: string;
  seq: number;
} & (
  // `other` is whom the leader started following, and there is one only for `leaderFollows`.
  | { reason: 'leaderFollows'; other: FollowOther }
  | { reason: PlainStopReason; other: null }
);

interface FollowState {
  /** The member being followed, or null. */
  targetUserId: string | null;
  /** The followed member's display name, or null while not following. */
  targetName: string | null;
  /** The last stop, or null when none has happened since the last start or reset. */
  stopped: FollowStop | null;
  /** Follow a member; following someone else switches straight over. */
  start: (userId: string, name: string) => void;
  /** Stop following and record why (and, for `leaderFollows`, whom); nothing happens while not following. */
  stop: (...args: StopArgs) => void;
  /** Clear everything without recording a stop (leaving the project). */
  reset: () => void;
}

let stopSeq = 0;

export const useFollowStore = create<FollowState>()((set, get) => ({
  targetUserId: null,
  targetName: null,
  stopped: null,
  start: (userId, name) => set({ targetUserId: userId, targetName: name, stopped: null }),
  stop: (...[reason, other]) => {
    const { targetUserId: userId, targetName } = get();
    if (userId === null) return;
    stopSeq += 1;
    const base = { userId, name: targetName ?? '', seq: stopSeq };
    const stopped: FollowStop = reason === 'leaderFollows' ? { ...base, reason, other } : { ...base, reason, other: null };
    set({ targetUserId: null, targetName: null, stopped });
  },
  reset: () => set({ targetUserId: null, targetName: null, stopped: null }),
}));

/**
 * Stop following because the user moved the view or pressed a stop control.
 * @param reason - Why; the user moving the viewport by default.
 */
export function stopFollowing(reason: PlainStopReason = 'viewport'): void {
  useFollowStore.getState().stop(reason);
}
