// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Read one awareness entry's holding, if it has a usable one.
 *
 * Every accepted connection has its `user.id` written by the server, so an
 * entry without one is either mid-handshake or something we have no name for
 * either way. The ids are checked rather than trusted: awareness carries
 * whatever a peer put there, and this feeds a render.
 * @param state - One client's awareness state.
 * @returns The user id and the node ids they hold, or null.
 */
function readHolding(
  state: Record<string, unknown>,
): { userId: string; nodeIds: readonly string[] } | null {
  const user = state.user;
  const userId =
    typeof user === 'object' && user !== null ? (user as { id?: unknown }).id : undefined;
  if (typeof userId !== 'string') return null;
  const held = state.activeNodeIds;
  if (!Array.isArray(held) || !held.every((id) => typeof id === 'string')) return null;
  return { userId, nodeIds: held as string[] };
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
    const holding = readHolding(state);
    if (holding === null) continue;
    for (const nodeId of holding.nodeIds) {
      const users = byNode.get(nodeId);
      if (users === undefined) {
        byNode.set(nodeId, [holding.userId]);
      } else if (!users.includes(holding.userId)) {
        users.push(holding.userId);
      }
    }
  }
  return byNode;
}
