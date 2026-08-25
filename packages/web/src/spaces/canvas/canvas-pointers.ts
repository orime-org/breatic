// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { readUserId } from '@web/spaces/canvas/awareness-user';

/** One collaborator's pointer, in canvas coordinates. */
export interface RemotePointer {
  /** The connection it came from, unique even between one person's tabs. */
  clientId: number;
  /** Who is behind that connection. */
  userId: string;
  /** Canvas x. */
  x: number;
  /** Canvas y. */
  y: number;
}

/**
 * Read a published pointer, if it is a usable pair of coordinates.
 * @param value - The raw `pointer` field off an awareness state.
 * @returns The point, or null when the peer is away or the field is malformed.
 */
function readPoint(value: unknown): { x: number; y: number } | null {
  // Guards an absent field, which destructuring would throw on. `null` needs
  // saying out loud because `typeof null` is `'object'`.
  if (typeof value !== 'object' || value === null) return null;
  const { x, y } = value as { x?: unknown; y?: unknown };
  // `Number.isFinite` does no conversion, so it answers the type question and
  // the NaN one at once: a string, a missing key and NaN all read false.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: x as number, y: y as number };
}

/**
 * Where every other connection's pointer is right now.
 *
 * One arrow per connection rather than per person: the same account in two
 * tabs really does have two pointers in two places, and picking one of them
 * to show would make the arrow jump between them.
 * @param states - The awareness states, as `getStates()` hands them over.
 * @param selfClientId - This client's id, whose own pointer is left out.
 * @returns The remote pointers, in the order awareness holds them.
 */
export function collectPointers(
  states: ReadonlyMap<number, Record<string, unknown>>,
  selfClientId: number,
): RemotePointer[] {
  const found: RemotePointer[] = [];
  for (const [clientId, state] of states) {
    if (clientId === selfClientId) continue;
    const userId = readUserId(state);
    if (userId === null) continue;
    const at = readPoint(state.pointer);
    if (at === null) continue;
    found.push({ clientId, userId, x: at.x, y: at.y });
  }
  return found;
}
