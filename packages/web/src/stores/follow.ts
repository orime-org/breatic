// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which project member this user is following (#920). Local only: whom a user
 * follows is never published in awareness.
 */

import { create } from 'zustand';

/**
 * Why following stopped: the stop button, the user moving the viewport or
 * switching the Space themselves, or the leader going offline.
 */
export type FollowStopReason = 'button' | 'viewport' | 'space' | 'offline';

/** The last stop, for the one notice it gets; `seq` tells two equal stops apart. */
export interface FollowStop {
  reason: FollowStopReason;
  userId: string;
  seq: number;
}

interface FollowState {
  /** The member being followed, or null. */
  targetUserId: string | null;
  /** The last stop, or null when none has happened since the last start or reset. */
  stopped: FollowStop | null;
  /** Follow a member; following someone else switches straight over. */
  start: (userId: string) => void;
  /** Stop following and record why; nothing happens while not following. */
  stop: (reason: FollowStopReason) => void;
  /** Clear everything without recording a stop (leaving the project). */
  reset: () => void;
}

let stopSeq = 0;

export const useFollowStore = create<FollowState>()((set, get) => ({
  targetUserId: null,
  stopped: null,
  start: (userId) => set({ targetUserId: userId, stopped: null }),
  stop: (reason) => {
    const userId = get().targetUserId;
    if (userId === null) return;
    stopSeq += 1;
    set({ targetUserId: null, stopped: { reason, userId, seq: stopSeq } });
  },
  reset: () => set({ targetUserId: null, stopped: null }),
}));
