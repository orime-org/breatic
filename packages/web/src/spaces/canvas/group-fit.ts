// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a Group must grow to so it still holds members that turned out bigger
 * than the box drawn around them (#2209).
 *
 * A Group is sized when it is made, and a member that is still uploading is a
 * fixed placeholder box; once its media arrives the node is as tall as the
 * media. Left alone the members would hang outside the box they arrived in, and
 * a nudge would take one out of the Group for good — a member whose centre is
 * outside the frame stops being a member at drag-stop.
 *
 * Kept out of the canvas component so the answer is a plan a test can walk:
 * geometry in, growths out, no writes.
 */

import type { Node } from '@xyflow/react';

import {
  EMPTY_NODE_SIZE,
  planGroupFitToMembers,
  type GroupGrowth,
  type GroupGrowthInput,
  type Rect,
} from '@web/spaces/canvas/group-geometry';
import { isNodeLocked } from '@web/spaces/canvas/group-membership';

/**
 * The growth every Group needs to hold what its members turned out to be.
 *
 * Positions come from the document and sizes from the render, so the only thing
 * that moves the answer is a member changing size — an in-flight drag says
 * nothing here, and the gesture's own release still owns where things land. A
 * locked Group is left exactly as it is: its frame is one of the things the
 * lock froze, so this end rewrites it for nobody.
 * @param places - The nodes as the document has them (geometry + parentId).
 * @param rendered - The render buffer, for each node's measured size.
 * @param heldByRemote - Groups a remote gesture is holding, which this end writes nothing about.
 * @returns One growth per Group that must get bigger.
 */
export function planMeasuredGroupFit(
  places: ReadonlyArray<Node>,
  rendered: ReadonlyArray<Node>,
  heldByRemote: ReadonlySet<string>,
): GroupGrowth[] {
  const measuredById = new Map(rendered.map((node) => [node.id, node]));
  const membersOf = new Map<string, Node[]>();
  for (const node of places) {
    if (node.parentId === undefined) continue;
    const kin = membersOf.get(node.parentId);
    if (kin === undefined) membersOf.set(node.parentId, [node]);
    else kin.push(node);
  }
  const inputs: GroupGrowthInput[] = [];
  for (const group of places) {
    if (group.type !== 'group' || heldByRemote.has(group.id)) continue;
    if (isNodeLocked(group)) continue;
    const members = membersOf.get(group.id);
    if (members === undefined) continue;
    const memberRects: Rect[] = members.map((node) => {
      const drawn = measuredById.get(node.id);
      return {
        x: group.position.x + node.position.x,
        y: group.position.y + node.position.y,
        width:
          drawn?.measured?.width ?? node.width ?? EMPTY_NODE_SIZE.width,
        height:
          drawn?.measured?.height ?? node.height ?? EMPTY_NODE_SIZE.height,
      };
    });
    inputs.push({
      groupId: group.id,
      rect: {
        x: group.position.x,
        y: group.position.y,
        width: group.width ?? EMPTY_NODE_SIZE.width,
        height: group.height ?? EMPTY_NODE_SIZE.height,
      },
      memberRects,
    });
  }
  return planGroupFitToMembers(inputs);
}
