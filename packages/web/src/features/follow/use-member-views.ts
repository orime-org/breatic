// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import type { Awareness } from 'y-protocols/awareness';

import { pickMemberViews, type MemberView } from '@web/data/yjs/follow-presence';

/** Each other member's view, by user id; a member with neither a view nor a following entry is absent. */
export type MemberViews = ReadonlyMap<string, MemberView>;

const EMPTY: MemberViews = new Map();

/** What `useSyncExternalStore` reads the member views through. */
interface MemberViewsStore {
  subscribe: (onChange: () => void) => () => void;
  read: (following: ReadonlyMap<string, string>) => MemberViews;
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
  let version = 0;
  let cache: { version: number; following: ReadonlyMap<string, string> | null; views: MemberViews } = { version: -1, following: null, views: EMPTY };
  return {
    subscribe: (onChange: () => void): (() => void) => {
      version += 1;
      /**
       * Note the change, then let React compare the snapshot.
       */
      const listener = (): void => {
        version += 1;
        onChange();
      };
      // `change`, not `update`: the keep-alive beat changes no entry.
      awareness.on('change', listener);
      return (): void => awareness.off('change', listener);
    },
    read: (following: ReadonlyMap<string, string>): MemberViews => {
      if (cache.version === version && cache.following === following) return cache.views;
      const next = pickMemberViews(awareness.getStates(), awareness.clientID, following);
      cache = { version, following, views: sameViews(cache.views, next) ? cache.views : next };
      return cache.views;
    },
  };
}

/**
 * Every other member's view (#920): the Space they have in front, from the
 * project's meta awareness, and whom they follow, from the server's following
 * table. Re-renders only when some member's Space or following changes, not
 * on every focus or time stamp rewrite.
 * @param metaAwareness - The project meta awareness, or null before it is attached.
 * @param following - Whom each member follows, `useProjectMeta(projectId).following`.
 * @returns The views by user id; empty without an awareness.
 */
export function useMemberViews(metaAwareness: Awareness | null, following: ReadonlyMap<string, string>): MemberViews {
  const store = React.useMemo(
    (): MemberViewsStore => (metaAwareness ? memberViewsStore(metaAwareness) : NO_STORE),
    [metaAwareness],
  );
  const read = React.useCallback((): MemberViews => store.read(following), [store, following]);
  return React.useSyncExternalStore(store.subscribe, read);
}
