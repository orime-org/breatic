// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import type { Awareness } from 'y-protocols/awareness';

import { collectNodeOccupants, sameOccupantTable } from '@web/spaces/canvas/node-occupants';

/** Node id to the user ids holding it. */
export type NodeOccupants = ReadonlyMap<string, readonly string[]>;

/** What every reader sees before an awareness has handed over anything. */
const EMPTY: NodeOccupants = new Map();

/** An external store over one awareness, in the shape React subscribes to. */
interface OccupantsStore {
  /** Register for snapshot changes; returns the unsubscribe. */
  subscribe: (onChange: () => void) => () => void;
  /** The current snapshot, stable until its contents change. */
  getSnapshot: () => NodeOccupants;
}

/**
 * Build the store that turns awareness notifications into stable snapshots.
 * @param awareness - The awareness to follow, or null when there is none.
 * @returns A store `useSyncExternalStore` can read.
 */
function createOccupantsStore(awareness: Awareness | null): OccupantsStore {
  let snapshot: NodeOccupants = EMPTY;
  /** Re-collect the table, keeping the previous one when it held still. */
  const refresh = (): void => {
    if (!awareness) return;
    const next = collectNodeOccupants(awareness.getStates(), awareness.clientID);
    if (!sameOccupantTable(snapshot, next)) snapshot = next;
  };
  return {
    /**
     * Follow this awareness until the returned function is called.
     * @param onChange - React's callback, run whenever the snapshot may differ.
     * @returns The unsubscribe.
     */
    subscribe: (onChange: () => void): (() => void) => {
      if (!awareness) return () => undefined;
      // Read once here as well: whatever arrived between the first render and
      // this subscription is otherwise not in the snapshot React compares.
      refresh();
      /** Re-read the states and let React compare the snapshot. */
      const listener = (): void => {
        refresh();
        onChange();
      };
      // `change` fires only when some entry's state actually differs — the
      // 15-second keep-alive raises a clock without one, and lands on `update`
      // alone (`y-protocols/awareness.js` compares deeply before listing a
      // client as updated).
      awareness.on('change', listener);
      return (): void => awareness.off('change', listener);
    },
    getSnapshot: () => snapshot,
  };
}

/**
 * Who is holding which node.
 *
 * This is the only place `activeNodeIds` enters React. The writer republishes
 * the whole awareness state at up to 30fps while a pointer moves (the protocol
 * has no per-field update), so a reader wired straight to the change event
 * would rebuild the node mirror thirty times a second over a holding that
 * never moved. The table is compared by value, and one that held still is
 * handed back as the same object — which is what an external store needs for
 * React to skip the render.
 * @param awareness - This space's awareness, or null before it is attached.
 * @returns The table, keeping its reference until its contents change.
 */
export function useCanvasOccupants(awareness: Awareness | null): NodeOccupants {
  const store = React.useMemo(() => createOccupantsStore(awareness), [awareness]);
  return React.useSyncExternalStore(store.subscribe, store.getSnapshot);
}
