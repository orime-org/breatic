// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { Awareness } from 'y-protocols/awareness';

import { readUserId } from '@web/data/yjs/awareness-user';
import { pickLeaderView } from '@web/data/yjs/follow-presence';
import { useAwarenessSlice } from '@web/data/yjs/use-awareness-slice';

/** What one member's picked `view` says: the Space in front and whom they follow. */
export interface MemberView {
  spaceId: string | null;
  following: string | null;
}

/** Each other member's picked view, by user id; a member without a view is absent. */
export type MemberViews = ReadonlyMap<string, MemberView>;

const EMPTY: MemberViews = new Map();

/**
 * Pick each other member's view from the meta awareness states.
 * @param states - The meta awareness states by client id.
 * @param selfClientId - This client's id, never a candidate.
 * @returns Each member's Space in front and whom they follow, by user id.
 */
function collectViews(states: ReadonlyMap<number, Record<string, unknown>>, selfClientId: number): MemberViews {
  const out = new Map<string, MemberView>();
  for (const [clientId, state] of states) {
    const userId = clientId === selfClientId ? null : readUserId(state);
    if (userId === null || out.has(userId)) continue;
    const view = pickLeaderView(states, userId, selfClientId);
    if (view !== null) out.set(userId, { spaceId: view.spaceId, following: view.following });
  }
  return out;
}

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
 * Every other member's picked view (#920), read from the project's meta
 * awareness: the Space they have in front and whom they follow. Re-renders
 * only when some member's Space or following changes, not on every focus or
 * time stamp rewrite.
 * @param metaAwareness - The project meta awareness, or null before it is attached.
 * @returns The views by user id; empty without an awareness.
 */
export function useMemberViews(metaAwareness: Awareness | null): MemberViews {
  return useAwarenessSlice(metaAwareness, EMPTY, collectViews, sameViews);
}
