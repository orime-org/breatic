// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Node-type connection rules (user-ratified 2026-07-10, batch spec §9.1).
 *
 * The whitelist itself moved to `@breatic/shared` when the agent began
 * proposing edges (#263): the check that judges a proposal sits in a library
 * package, and a ratified product rule written twice drifts apart the first
 * time it changes. Re-exported here so the canvas keeps one import for the
 * rule and the click-gesture resolver that reads it.
 */

import { canConnect } from '@breatic/shared';

export { canConnect };

/**
 * Resolves whether a completed CLICK-connect gesture (tap a handle, tap a
 * second handle) was refused by the connection rules and deserves the
 * rejection toast.
 *
 * xyflow's `onClickConnectEnd` hands over the DRAG connection state, which a
 * pure tap-tap gesture never populates (round-3 adversarial: keying the toast
 * on it made the click path silently reject). This resolver reconstructs the
 * gesture from the click-start params and the second click's node instead.
 * Cancels (no second node), self taps, missing click-starts, and allowed
 * pairs all resolve to null — only a rule rejection returns the kinds to name
 * in the toast.
 * @param input - The reconstructed gesture.
 * @param input.from - The click-start handle (node id + handle type), or null
 *   when no click-connect was armed.
 * @param input.toNodeId - The node under the second click, or null (empty
 *   canvas / non-node click = cancel).
 * @param input.kindOf - Resolves a node id to its kind.
 * @returns The rejected source/target kinds, or null when no toast is due.
 */
export function resolveClickConnectRejection(input: {
  from: { nodeId: string; handleType: 'source' | 'target' } | null;
  toNodeId: string | null;
  kindOf: (nodeId: string) => string | undefined;
}): { sourceKind: string; targetKind: string } | null {
  const { from, toNodeId, kindOf } = input;
  if (!from || !toNodeId || toNodeId === from.nodeId) return null;
  const fromKind = kindOf(from.nodeId) ?? '';
  const toKind = kindOf(toNodeId) ?? '';
  const sourceKind = from.handleType === 'source' ? fromKind : toKind;
  const targetKind = from.handleType === 'source' ? toKind : fromKind;
  if (canConnect(sourceKind, targetKind)) return null;
  return { sourceKind, targetKind };
}
