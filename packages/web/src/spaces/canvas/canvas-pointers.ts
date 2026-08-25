// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

/**
 * Whether two collected pointer lists say the same thing.
 *
 * The same job `sameOccupantTable` does for the holding, and for the same
 * reason: one awareness carries both fields and the writer republishes the
 * whole state at up to 30fps, so a peer moving nothing but its holding still
 * raises a change here.
 * @param a - The list already on screen.
 * @param b - The freshly collected one.
 * @returns True when neither the peers nor their positions moved.
 */
export function samePointers(
  a: readonly RemotePointer[],
  b: readonly RemotePointer[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index];
    return (
      right !== undefined &&
      left.clientId === right.clientId &&
      left.userId === right.userId &&
      left.x === right.x &&
      left.y === right.y
    );
  });
}

/** What `screenToFlowPosition` accepts, narrowed to what this call needs. */
type ScreenToCanvas = (
  screen: { x: number; y: number },
  options?: { snapToGrid?: boolean },
) => { x: number; y: number };

/**
 * Turn a screen point into the canvas point to publish.
 *
 * Snapping is off explicitly: `screenToFlowPosition` reads the store's
 * `snapToGrid` when the option is absent, and the viewport toolbar's snap
 * switch feeds that flag — with it on, the published pointer would quantise to
 * `SNAP_GRID`, landing up to half a step from where the person is pointing.
 * @param convert - ReactFlow's `screenToFlowPosition`.
 * @param screen - The pointer's screen coordinates.
 * @param screen.x - Screen x.
 * @param screen.y - Screen y.
 * @returns The canvas point.
 */
export function toCanvasPoint(
  convert: ScreenToCanvas,
  screen: { x: number; y: number },
): { x: number; y: number } {
  return convert(screen, { snapToGrid: false });
}
