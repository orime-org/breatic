// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Node } from '@xyflow/react';

import type { GestureTable } from '@web/spaces/canvas/gesture-table';

/** What this module needs off a document node: where the document puts it. */
export interface DocumentPlace {
  /** The node's id. */
  id: string;
  /** Its position as the document has it — relative to the Group for a member. */
  position: { x: number; y: number };
}

/**
 * The render buffer with every remote gesture taken back out of it.
 *
 * The buffer is what the canvas draws, and while a collaborator drags something
 * it holds that collaborator's in-flight coordinates. It is also where several
 * paths read geometry from on their way to writing the document — a Group
 * growing around its members, a resize absorbing a loose node, a new Group
 * sizing itself, a duplicate growing the Group it lands in. Any of those
 * running mid-drag would write somebody else's moving coordinates into the
 * document, where they stay.
 *
 * Position comes back from the document; the size stays as the buffer has it,
 * because `toFlowNode` emits no size for anything but a Group with a stored one
 * — a plain node's dimensions live only in `measured`, and no document geometry
 * can put them back.
 *
 * This is the single door: every call site that turns buffer geometry into a
 * document write goes through here, so a new one is a call that did not use it
 * rather than an entry missing from a list.
 * @param flowNodes - The render buffer.
 * @param docNodes - The nodes as the document has them.
 * @param remoteGesture - The nodes remote gestures are currently moving.
 * @returns The buffer with those nodes back at their document positions, or the
 *   buffer itself when no remote gesture touches it.
 */
export function docGeometryView(
  flowNodes: ReadonlyArray<Node>,
  docNodes: ReadonlyArray<DocumentPlace>,
  remoteGesture: GestureTable,
): Node[] {
  if (remoteGesture.size === 0) return flowNodes as Node[];
  const placeById = new Map(docNodes.map((n) => [n.id, n.position]));
  let changed = false;
  const view = flowNodes.map((node) => {
    if (!remoteGesture.has(node.id)) return node;
    const place = placeById.get(node.id);
    // A node the document has dropped keeps what the buffer holds; deciding
    // whether it still exists belongs to the caller, not to this view.
    if (place === undefined) return node;
    changed = true;
    return { ...node, position: place };
  });
  return changed ? view : (flowNodes as Node[]);
}
