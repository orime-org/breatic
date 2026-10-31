// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Awareness } from 'y-protocols/awareness';

import {
  collectPeerActivity,
  samePeerActivity,
  type PeerActivity,
} from '@web/spaces/canvas/node-activity';
import { useAwarenessSlice } from '@web/spaces/canvas/use-awareness-slice';

/** The table every node reads while nobody else is doing anything. */
const EMPTY: PeerActivity = new Map();

/**
 * Who else is doing what to which node (inner#1303 §6.8).
 *
 * Compared by value, so pointer traffic from the same peers hands back the
 * same table and nothing below re-renders.
 * @param awareness - This space's awareness, or null before it is attached.
 * @returns The table, keeping its reference until its contents change.
 * @throws {never} Never.
 */
export function usePeerActivity(awareness: Awareness | null): PeerActivity {
  return useAwarenessSlice(awareness, EMPTY, collectPeerActivity, samePeerActivity);
}
