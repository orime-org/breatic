// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The geometry one node is being shown at while a gesture moves it.
 *
 * Absolute canvas coordinates, so the sender does not depend on the reader's
 * view of who is inside which Group. A member's relative position is worked
 * out on arrival.
 */
export interface GestureGeometry {
  /** Horizontal position, in absolute canvas coordinates. */
  x: number;
  /** Vertical position, in absolute canvas coordinates. */
  y: number;
  /** Width, carried only by a Group being resized. */
  width?: number;
  /** Height, carried only by a Group being resized. */
  height?: number;
  /**
   * The node this entry rode in on: itself when the gesture has hold of it,
   * its Group when it came along as a member.
   *
   * A gesture settles what it holds when it takes hold and never asks again,
   * so a member that leaves the Group while the gesture runs is still listed,
   * at a place inside a Group it is no longer in. The reader needs to know
   * which Group an entry speaks for to tell that entry apart from one for a
   * node the gesture has hold of directly.
   */
  root?: string;
}

/** Node id to the geometry a gesture is showing it at. */
export type GestureTable = ReadonlyMap<string, GestureGeometry>;

/** The same table on the wire, where awareness carries plain objects. */
export type GestureBatch = Record<string, GestureGeometry>;

/**
 * Whether a value is a finite number, which every coordinate has to be.
 *
 * `NaN` and the infinities are rejected as hard as a string is: they survive a
 * JSON round trip as null, and a coordinate that is not a real place puts a
 * node nowhere on the canvas.
 * @param value - The raw value.
 * @returns True when it is a number that names a place.
 */
function isCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Read one node's geometry out of a raw entry.
 * @param value - The raw entry.
 * @returns The geometry, or null when the entry is malformed.
 */
function readGeometry(value: unknown): GestureGeometry | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!isCoordinate(raw.x) || !isCoordinate(raw.y)) return null;
  const geometry: GestureGeometry =
    typeof raw.root === 'string' && raw.root !== ''
      ? { x: raw.x, y: raw.y, root: raw.root }
      : { x: raw.x, y: raw.y };
  // A size travels only with a Group being resized, so absent is sound and
  // present-but-not-a-number is not: a Group drawn at a nonsense size is worse
  // than one drawn at the size the document already knows.
  if (raw.width !== undefined || raw.height !== undefined) {
    if (!isCoordinate(raw.width) || !isCoordinate(raw.height)) return null;
    return { ...geometry, width: raw.width, height: raw.height };
  }
  return geometry;
}

/**
 * Read the gesture field off one awareness state.
 *
 * The shape is checked rather than trusted: awareness carries whatever a peer
 * put there, and this feeds a render. A malformed entry is dropped on its own
 * so one bad node does not cost the reader the rest of the batch.
 * @param value - The raw field off an awareness state.
 * @returns The table it describes, or null when the field is absent or malformed.
 */
export function readGestureField(value: unknown): GestureTable | null {
  if (typeof value !== 'object' || value === null) return null;
  const table = new Map<string, GestureGeometry>();
  for (const [nodeId, raw] of Object.entries(value as Record<string, unknown>)) {
    const geometry = readGeometry(raw);
    if (geometry !== null) table.set(nodeId, geometry);
  }
  return table;
}

/**
 * Compare two geometries field by field.
 * @param a - One geometry.
 * @param b - The other geometry.
 * @returns True when both describe the same place and size.
 */
export function sameGeometry(a: GestureGeometry, b: GestureGeometry): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

/**
 * Compare two gesture tables by value, so a table that held still can be
 * handed back as the same object and cost the render nothing.
 * @param a - The previous table.
 * @param b - The freshly collected table.
 * @returns True when the two describe the same geometry for the same nodes.
 */
export function sameGestureTable(a: GestureTable, b: GestureTable): boolean {
  if (a.size !== b.size) return false;
  for (const [nodeId, geometry] of a) {
    const other = b.get(nodeId);
    if (other === undefined || !sameGeometry(geometry, other)) return false;
  }
  return true;
}

/**
 * Merge every remote client's gesture into one table.
 *
 * Identity plays no part: this table answers what geometry a node is at right
 * now, and who is holding it is already answered by the occupant tags. Two
 * remotes moving one node resolve to whichever awareness lists later — its
 * table is keyed by client id in first-seen order, so the tie-break is which
 * client joined later, and it holds still for as long as both are connected.
 * @param states - The awareness states, as `getStates()` hands them over.
 * @param selfClientId - This client's id, whose own gesture is left out.
 * @returns Node id to the geometry a remote gesture is showing it at.
 */
export function collectRemoteGesture(
  states: ReadonlyMap<number, Record<string, unknown>>,
  selfClientId: number,
): GestureTable {
  const merged = new Map<string, GestureGeometry>();
  for (const [clientId, state] of states) {
    if (clientId === selfClientId) continue;
    const table = readGestureField(state.gesture);
    if (table === null) continue;
    for (const [nodeId, geometry] of table) merged.set(nodeId, geometry);
  }
  return merged;
}
