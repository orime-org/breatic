// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Who is holding what, one table per renderer.
 *
 * Nodes and edges are kept apart all the way from the wire (`activeNodeIds`
 * and `activeEdgeIds` are two fields) to here, because the two renderers are
 * two: mixing them would make each one probe both tables to find out what an
 * id even refers to.
 */
export interface CanvasOccupants {
  /** Node id to the user ids holding it, each user listed once. */
  byNode: Map<string, string[]>;
  /** Edge id to the user ids holding it, each user listed once. */
  byEdge: Map<string, string[]>;
}

/**
 * Read one awareness entry's user id, if the server has stamped one.
 *
 * Every accepted connection has its `user.id` written by the server, so an
 * entry without one is either mid-handshake or something we have no name for
 * either way.
 * @param state - One client's awareness state.
 * @returns The user id, or null when there is none to render.
 */
function readUserId(state: Record<string, unknown>): string | null {
  const user = state.user;
  const id = typeof user === 'object' && user !== null ? (user as { id?: unknown }).id : undefined;
  return typeof id === 'string' ? id : null;
}

/**
 * Read one holding field as a list of ids.
 *
 * The shape is checked rather than trusted: awareness carries whatever a peer
 * put there, and this feeds a render. Each field is checked on its own, so a
 * peer publishing junk in one of them still has the other one read.
 * @param value - The raw field off an awareness state.
 * @returns The ids, or null when the field is absent, empty or malformed.
 */
function readIdList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((id) => typeof id === 'string')) return null;
  return value as string[];
}

/**
 * Add one holder to a table, keeping each person listed once per key.
 *
 * The same account in two browser tabs is two client ids and one person to
 * show, so the user id is what gets deduplicated, not the client id.
 * @param table - The table to add to, mutated in place.
 * @param keys - The ids this user holds.
 * @param userId - The user holding them.
 */
function addHolder(
  table: Map<string, string[]>,
  keys: readonly string[],
  userId: string,
): void {
  for (const key of keys) {
    const users = table.get(key);
    if (users === undefined) {
      table.set(key, [userId]);
    } else if (!users.includes(userId)) {
      users.push(userId);
    }
  }
}

/**
 * Turn the awareness states into the two tables the canvas renders from.
 * @param states - The awareness states, as `getStates()` hands them over.
 * @param selfClientId - This client's id, whose own holding is left out.
 * @returns The node table and the edge table.
 */
export function collectOccupants(
  states: ReadonlyMap<number, Record<string, unknown>>,
  selfClientId: number,
): CanvasOccupants {
  const byNode = new Map<string, string[]>();
  const byEdge = new Map<string, string[]>();
  for (const [clientId, state] of states) {
    if (clientId === selfClientId) continue;
    const userId = readUserId(state);
    if (userId === null) continue;
    const nodeIds = readIdList(state.activeNodeIds);
    if (nodeIds !== null) addHolder(byNode, nodeIds, userId);
    const edgeIds = readIdList(state.activeEdgeIds);
    if (edgeIds !== null) addHolder(byEdge, edgeIds, userId);
  }
  return { byNode, byEdge };
}
