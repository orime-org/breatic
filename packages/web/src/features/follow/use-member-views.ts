// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import type { Awareness } from 'y-protocols/awareness';

import { FollowingKeeper, pickMemberViews, type AwarenessChange, type MemberView } from '@web/data/yjs/follow-presence';

/** Each other member's view, by user id; a member with no tab publishing either field is absent. */
export type MemberViews = ReadonlyMap<string, MemberView>;

const EMPTY: MemberViews = new Map();

/** What `useSyncExternalStore` reads the member views through. */
interface MemberViewsStore {
  subscribe: (onChange: () => void) => () => void;
  read: (onlineUserIds: ReadonlySet<string>) => MemberViews;
}

/** The store while there is no awareness: nothing to list. */
const NO_STORE: MemberViewsStore = { subscribe: () => () => undefined, read: () => EMPTY };

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
 * A store over one meta awareness that hands back the same collection until
 * some member's Space or following changes.
 * @param awareness - The project meta awareness.
 * @returns The store.
 */
function memberViewsStore(awareness: Awareness): MemberViewsStore {
  const keeper = new FollowingKeeper(awareness);
  let version = 0;
  let cache: { version: number; online: ReadonlySet<string> | null; views: MemberViews } = { version: -1, online: null, views: EMPTY };
  return {
    subscribe: (onChange: () => void): (() => void) => {
      keeper.seed();
      version += 1;
      /**
       * Take in the change, then let React compare the snapshot.
       * @param change - The clients the event lists.
       * @param origin - The event's origin.
       */
      const listener = (change: AwarenessChange, origin: unknown): void => {
        keeper.observe(change, origin);
        version += 1;
        onChange();
      };
      // `change`, not `update`: the keep-alive beat changes no entry.
      awareness.on('change', listener);
      return (): void => awareness.off('change', listener);
    },
    read: (onlineUserIds: ReadonlySet<string>): MemberViews => {
      if (cache.version === version && cache.online === onlineUserIds) return cache.views;
      const next = pickMemberViews(awareness.getStates(), awareness.clientID, keeper.kept(onlineUserIds));
      cache = { version, online: onlineUserIds, views: sameViews(cache.views, next) ? cache.views : next };
      return cache.views;
    },
  };
}

/**
 * Every other member's view (#920), read from the project's meta awareness:
 * the Space they have in front and whom they follow. A member whose entry
 * awareness dropped for silence keeps following while the server still counts
 * them online. Re-renders only when some member's Space or following changes,
 * not on every focus or time stamp rewrite.
 * @param metaAwareness - The project meta awareness, or null before it is attached.
 * @param onlineUserIds - The members the server's presence records count as online.
 * @returns The views by user id; empty without an awareness.
 */
export function useMemberViews(metaAwareness: Awareness | null, onlineUserIds: ReadonlySet<string>): MemberViews {
  const store = React.useMemo(
    (): MemberViewsStore => (metaAwareness ? memberViewsStore(metaAwareness) : NO_STORE),
    [metaAwareness],
  );
  const read = React.useCallback((): MemberViews => store.read(onlineUserIds), [store, onlineUserIds]);
  return React.useSyncExternalStore(store.subscribe, read);
}
