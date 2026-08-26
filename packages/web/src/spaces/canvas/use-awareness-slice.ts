// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import type { Awareness } from 'y-protocols/awareness';

/** What a slice needs to turn awareness notifications into a stable value. */
interface Slice<T> {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => T;
}

/**
 * Follow one derived view of this space's awareness, holding its reference
 * still while the view itself does not move.
 *
 * The protocol has no per-field update: a writer republishes its whole state
 * at up to 30fps while a pointer moves, so a reader wired straight to the
 * change event rebuilds thirty times a second over something that never
 * changed. Each slice collects what it cares about and says whether the result
 * is the same as before; an unchanged result is handed back as the same
 * object, which is what lets React skip the render.
 * @param awareness - This space's awareness, or null before it is attached.
 * @param empty - The value to report while there is no awareness.
 * @param collect - Builds the view from the states and this client's id.
 * @param same - Whether two collected views say the same thing.
 * @returns The view, keeping its reference until its contents change.
 */
export function useAwarenessSlice<T>(
  awareness: Awareness | null,
  empty: T,
  collect: (
    states: ReadonlyMap<number, Record<string, unknown>>,
    selfClientId: number,
  ) => T,
  same: (a: T, b: T) => boolean,
): T {
  const store = React.useMemo((): Slice<T> => {
    let snapshot: T = empty;
    /** Re-collect the view, keeping the previous one when it held still. */
    const refresh = (): void => {
      if (!awareness) return;
      const next = collect(awareness.getStates(), awareness.clientID);
      if (!same(snapshot, next)) snapshot = next;
    };
    return {
      subscribe: (onChange: () => void): (() => void) => {
        if (!awareness) return () => undefined;
        // Read once here as well: whatever arrived between the first render
        // and this subscription is otherwise not in the snapshot React
        // compares.
        refresh();
        /** Re-read the states and let React compare the snapshot. */
        const listener = (): void => {
          refresh();
          onChange();
        };
        // `change` fires only when some entry's state actually differs — the
        // 15-second keep-alive raises a clock without one, and lands on
        // `update` alone (`y-protocols/awareness.js` compares deeply before
        // listing a client as updated).
        awareness.on('change', listener);
        return (): void => awareness.off('change', listener);
      },
      getSnapshot: () => snapshot,
    };
    // `empty`, `collect` and `same` are module constants at every call site;
    // the awareness is what a new store is built for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awareness]);
  return React.useSyncExternalStore(store.subscribe, store.getSnapshot);
}
