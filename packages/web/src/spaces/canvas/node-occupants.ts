// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readUserId } from '@web/spaces/canvas/awareness-user';

/**
 * Compare two occupant tables by value.
 *
 * Order counts on both levels: the key order decides nothing on screen, but
 * comparing it is what makes this a single walk, and the holder order is the
 * order the name tags are laid out in — a swap really is a different picture.
 * @param a - The previous table.
 * @param b - The freshly collected table.
 * @returns True when the two describe the same holdings.
 */
export function sameOccupantTable(
  a: ReadonlyMap<string, readonly string[]>,
  b: ReadonlyMap<string, readonly string[]>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, users] of a) {
    const other = b.get(key);
    if (other === undefined || other.length !== users.length) return false;
    if (!users.every((id, i) => id === other[i])) return false;
  }
  return true;
}

/**
 * Read the holding field as a list of node ids.
 *
 * The shape is checked rather than trusted: awareness carries whatever a peer
 * put there, and this feeds a render.
 * @param value - The raw field off an awareness state.
 * @returns The ids, or null when the field is absent or malformed.
 */
function readIdList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((id) => typeof id === 'string')) return null;
  return value as string[];
}

/**
 * Who is holding which node, keyed by node id.
 *
 * One person is listed once per node however many entries point at them: the
 * same account in two browser tabs is two client ids and one person to show.
 * @param states - The awareness states, as `getStates()` hands them over.
 * @param selfClientId - This client's id, whose own holding is left out.
 * @returns Node id to the user ids holding it, each user listed once.
 */
export function collectNodeOccupants(
  states: ReadonlyMap<number, Record<string, unknown>>,
  selfClientId: number,
): Map<string, string[]> {
  const byNode = new Map<string, string[]>();
  for (const [clientId, state] of states) {
    if (clientId === selfClientId) continue;
    const userId = readUserId(state);
    if (userId === null) continue;
    const nodeIds = readIdList(state.activeNodeIds);
    if (nodeIds === null) continue;
    for (const nodeId of nodeIds) {
      const users = byNode.get(nodeId);
      if (users === undefined) {
        byNode.set(nodeId, [userId]);
      } else if (!users.includes(userId)) {
        users.push(userId);
      }
    }
  }
  return byNode;
}
