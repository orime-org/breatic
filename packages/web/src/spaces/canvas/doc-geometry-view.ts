// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Node } from '@xyflow/react';

import type { GestureTable } from '@web/spaces/canvas/gesture-table';

/** A node as the document has it, mapped the way the render buffer expects. */
export type DocumentPlace = Node;

/**
 * Nodes this end is allowed to write, out of a set it might otherwise write all
 * of.
 *
 * A node a remote gesture is holding is on screen at coordinates that are about
 * to change and that the document has never held, so this end does not commit
 * anything about it — the gesture's own release will. Use this only where the
 * set exists to produce writes, one per entry: a planner that draws conclusions
 * from a node's absence needs the whole buffer and is told separately which of
 * those nodes may take part.
 * @param nodes - The candidates a write would be produced for.
 * @param remoteGesture - The nodes remote gestures are currently moving.
 * @returns Those of them no remote gesture is holding, or the array itself when
 *   no remote gesture is running.
 */
export function landingCandidates(
  nodes: ReadonlyArray<Node>,
  remoteGesture: GestureTable,
): Node[] {
  if (remoteGesture.size === 0) return nodes as Node[];
  return nodes.filter((node) => !remoteGesture.has(node.id));
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
 * Geometry comes back from the document — a Group's size included, because the
 * document stores it and a remote resize is showing a different one. That size
 * replaces `measured` too, since every call site sizes a node as
 * `measured?.width ?? width` and would otherwise read the in-flight one. A
 * plain node keeps the `measured` it has: its dimensions live only there, and
 * no document geometry can put them back.
 *
 * This is the single door: every call site that turns buffer geometry into a
 * document write goes through here, so a new one is a call that did not use it
 * rather than an entry missing from a list.
 * @param flowNodes - The render buffer.
 * @param docNodes - The nodes as the document has them, mapped by `toFlowNode`.
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
  const docById = new Map(docNodes.map((n) => [n.id, n]));
  let changed = false;
  const view = flowNodes.map((node) => {
    if (!remoteGesture.has(node.id)) return node;
    const inDocument = docById.get(node.id);
    // A node the document has dropped keeps what the buffer holds; deciding
    // whether it still exists belongs to the caller, not to this view.
    if (inDocument === undefined) return node;
    changed = true;
    const stored =
      inDocument.width !== undefined && inDocument.height !== undefined
        ? { width: inDocument.width, height: inDocument.height }
        : undefined;
    return {
      ...node,
      position: inDocument.position,
      width: inDocument.width,
      height: inDocument.height,
      ...(stored === undefined ? {} : { measured: stored }),
    };
  });
  return changed ? view : (flowNodes as Node[]);
}
