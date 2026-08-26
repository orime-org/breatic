// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Node } from '@xyflow/react';

import type { GestureTable } from '@web/spaces/canvas/gesture-table';

/** A node as the document has it, mapped the way the render buffer expects. */
export type DocumentPlace = Node;

/**
 * The nodes a landing decision is allowed to consider.
 *
 * Dropping a node decides two things off the geometry around it: which Group it
 * lands in, and how far that Group has to grow. Both are aimed by eye, so they
 * have to be decided from what is on screen — and what a remote gesture is
 * moving is on screen at coordinates that are about to change and that the
 * document has never held. Whichever geometry such a node were judged by, the
 * answer could disagree with what the user was aiming at.
 *
 * So it takes no part: a Group somebody else is dragging neither receives a
 * node nor grows around one, and a node somebody else is dragging is not
 * absorbed by a resize. It goes back to being a landing target the moment that
 * gesture ends.
 * @param nodes - The nodes to choose from.
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
 * document stores it and a remote resize is showing a different one. What stays
 * is `measured`: a plain node's dimensions live only there, and no document
 * geometry can put them back.
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
    return {
      ...node,
      position: inDocument.position,
      width: inDocument.width,
      height: inDocument.height,
    };
  });
  return changed ? view : (flowNodes as Node[]);
}
