// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import type { Awareness } from 'y-protocols/awareness';

import type { CanvasOccupants } from '@web/spaces/canvas/occupants';
import { collectOccupants, sameOccupantTable } from '@web/spaces/canvas/occupants';

/** What every reader sees before an awareness has handed over anything. */
const EMPTY: CanvasOccupants = { byNode: new Map(), byEdge: new Map() };

/**
 * Carry over the tables that did not change, so their references stay put.
 *
 * Both unchanged returns the previous value itself, which is what lets React
 * skip the render entirely.
 * @param prev - The snapshot the readers are holding.
 * @param next - What awareness says now.
 * @returns The snapshot to hand the readers.
 */
function carryOverUnchanged(prev: CanvasOccupants, next: CanvasOccupants): CanvasOccupants {
  const sameNodes = sameOccupantTable(prev.byNode, next.byNode);
  const sameEdges = sameOccupantTable(prev.byEdge, next.byEdge);
  if (sameNodes && sameEdges) return prev;
  return {
    byNode: sameNodes ? prev.byNode : next.byNode,
    byEdge: sameEdges ? prev.byEdge : next.byEdge,
  };
}

/** An external store over one awareness, in the shape React subscribes to. */
interface OccupantsStore {
  /** Register for snapshot changes; returns the unsubscribe. */
  subscribe: (onChange: () => void) => () => void;
  /** The current snapshot, stable until its contents change. */
  getSnapshot: () => CanvasOccupants;
}

/**
 * Build the store that turns awareness notifications into stable snapshots.
 * @param awareness - The awareness to follow, or null when there is none.
 * @returns A store `useSyncExternalStore` can read.
 */
function createOccupantsStore(awareness: Awareness | null): OccupantsStore {
  let snapshot: CanvasOccupants = EMPTY;
  /** Re-collect the tables, keeping whichever of them held still. */
  const refresh = (): void => {
    if (!awareness) return;
    snapshot = carryOverUnchanged(
      snapshot,
      collectOccupants(awareness.getStates(), awareness.clientID),
    );
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
 * Who is holding which node and which edge, as one table each.
 *
 * This is the only place `activeNodeIds` and `activeEdgeIds` enter React. The
 * writer republishes the whole awareness state at up to 30fps while a pointer
 * moves (the protocol has no per-field update), so a reader wired straight to
 * the change event would rebuild the node and edge mirrors thirty times a
 * second over a holding that never moved. Each table is compared by value, and
 * a snapshot whose tables both held still is handed back as the same object —
 * which is what an external store needs for React to skip the render.
 * @param awareness - This space's awareness, or null before it is attached.
 * @returns The two tables, each keeping its reference until its own contents change.
 */
export function useCanvasOccupants(awareness: Awareness | null): CanvasOccupants {
  const store = React.useMemo(() => createOccupantsStore(awareness), [awareness]);
  return React.useSyncExternalStore(store.subscribe, store.getSnapshot);
}
