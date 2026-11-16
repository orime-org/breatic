// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { Awareness } from 'y-protocols/awareness';

import { pickMemberViews, type MemberView } from '@web/data/yjs/follow-presence';
import { useAwarenessSlice } from '@web/data/yjs/use-awareness-slice';

/** Each other member's view, by user id; a member with no tab publishing either field is absent. */
export type MemberViews = ReadonlyMap<string, MemberView>;

const EMPTY: MemberViews = new Map();

/**
 * Whether two collections hold the same Space and following for the same members.
 * @param a - One collection.
 * @param b - The other.
 * @returns True when they hold the same entries.
 */
function sameViews(a: MemberViews, b: MemberViews): boolean {
  if (a.size !== b.size) return false;
  for (const [userId, view] of a) {
    const other = b.get(userId);
    if (other === undefined || other.spaceId !== view.spaceId || other.following !== view.following) return false;
  }
  return true;
}

/**
 * Every other member's view (#920), read from the project's meta awareness:
 * the Space they have in front and whom they follow. Re-renders only when
 * some member's Space or following changes, not on every focus or time stamp
 * rewrite.
 * @param metaAwareness - The project meta awareness, or null before it is attached.
 * @returns The views by user id; empty without an awareness.
 */
export function useMemberViews(metaAwareness: Awareness | null): MemberViews {
  return useAwarenessSlice(metaAwareness, EMPTY, pickMemberViews, sameViews);
}
