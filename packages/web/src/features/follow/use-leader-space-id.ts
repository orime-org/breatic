// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { Awareness } from 'y-protocols/awareness';

import { readUserId } from '@web/data/yjs/awareness-user';
import { pickLeaderView } from '@web/data/yjs/follow-presence';
import { useAwarenessSlice } from '@web/data/yjs/use-awareness-slice';

/** Each member's picked `view.spaceId`, by user id; a member without a view is absent. */
type SpaceIdsByUser = ReadonlyMap<string, string | null>;

const EMPTY: SpaceIdsByUser = new Map();

/**
 * Pick each other member's view from the meta awareness states.
 * @param states - The meta awareness states by client id.
 * @param selfClientId - This client's id, never a candidate.
 * @returns The Space each member has in front, by user id.
 */
function collectSpaceIds(states: ReadonlyMap<number, Record<string, unknown>>, selfClientId: number): SpaceIdsByUser {
  const out = new Map<string, string | null>();
  for (const [clientId, state] of states) {
    const userId = clientId === selfClientId ? null : readUserId(state);
    if (userId === null || out.has(userId)) continue;
    const view = pickLeaderView(states, userId, selfClientId);
    if (view !== null) out.set(userId, view.spaceId);
  }
  return out;
}

/**
 * Whether two collections name the same Space for the same members.
 * @param a - One collection.
 * @param b - The other.
 * @returns True when they hold the same entries.
 */
function sameSpaceIds(a: SpaceIdsByUser, b: SpaceIdsByUser): boolean {
  if (a.size !== b.size) return false;
  for (const [userId, spaceId] of a) {
    if (!b.has(userId) || b.get(userId) !== spaceId) return false;
  }
  return true;
}

/**
 * The Space the followed member has in front (#920), read from the project's
 * meta awareness. Re-renders only when some member's Space changes, not on
 * every focus or time stamp rewrite.
 * @param metaAwareness - The project meta awareness, or null before it is attached.
 * @param leaderId - The followed member's user id, or null while not following.
 * @returns The leader's Space id, or null when not following or the leader shows none.
 */
export function useLeaderSpaceId(metaAwareness: Awareness | null, leaderId: string | null): string | null {
  const spaceIds = useAwarenessSlice(metaAwareness, EMPTY, collectSpaceIds, sameSpaceIds);
  return leaderId === null ? null : spaceIds.get(leaderId) ?? null;
}
