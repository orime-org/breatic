// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Awareness } from 'y-protocols/awareness';

import type { GestureTable } from '@web/spaces/canvas/gesture-table';
import { collectRemoteGesture, sameGestureTable } from '@web/spaces/canvas/gesture-table';
import { useAwarenessSlice } from '@web/spaces/canvas/use-awareness-slice';

/** The table every node reads while nobody else is moving anything. */
const EMPTY: GestureTable = new Map();

/**
 * The geometry remote gestures are showing nodes at.
 *
 * This is the only place the `gesture` field enters React. The table is
 * compared by value and one that held still is handed back as the same object,
 * so a peer republishing its whole state thirty times a second over a pointer
 * that moved — while its gesture geometry did not — costs the merge nothing.
 * @param awareness - This space's awareness, or null before it is attached.
 * @returns The table, keeping its reference until its contents change.
 */
export function useRemoteGesture(awareness: Awareness | null): GestureTable {
  return useAwarenessSlice(awareness, EMPTY, collectRemoteGesture, sameGestureTable);
}
