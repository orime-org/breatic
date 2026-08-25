// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Awareness } from 'y-protocols/awareness';

import { collectNodeOccupants, sameOccupantTable } from '@web/spaces/canvas/node-occupants';
import { useAwarenessSlice } from '@web/spaces/canvas/use-awareness-slice';

/** Node id to the user ids holding it. */
export type NodeOccupants = ReadonlyMap<string, readonly string[]>;

/** The table every node reads while nobody is holding anything. */
const EMPTY: NodeOccupants = new Map();

/**
 * Who is holding which node.
 *
 * This is the only place `activeNodeIds` enters React. The table is compared
 * by value and one that held still is handed back as the same object, so a
 * writer republishing its whole state thirty times a second over a holding
 * that never moved costs the node mirror nothing.
 * @param awareness - This space's awareness, or null before it is attached.
 * @returns The table, keeping its reference until its contents change.
 */
export function useCanvasOccupants(awareness: Awareness | null): NodeOccupants {
  return useAwarenessSlice(
    awareness,
    EMPTY,
    collectNodeOccupants,
    sameOccupantTable,
  );
}
