// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Filling and clearing a slot — the only place in web that knows which node
 * fields one slot owns.
 *
 * What a fill stores (`slotFillValue`) and the bodies collab writes with live
 * in `@breatic/shared/canvas-model` (`slot-fill.ts`, breatic#1488 §8.1); these
 * write through `setNodeSlotValue`, which asks the size cap. A slot owns
 * exactly one node field, and the whole pick lives inside it (#1918).
 */

import { setNodeSlotValue } from '@web/data/yjs/canvas-space';
import { slotFillValue } from '@breatic/shared/canvas-model';
import type { ClickedNode } from '@breatic/shared/canvas-model';
import type { SlotSpec } from '@breatic/shared/canvas-model';

/**
 * Copies a clicked node into a slot.
 *
 * Refuses the click when the node cannot fill the slot — the candidate
 * dimming already says so, and this backstops an insisting click. A node with
 * no poster clears the poster key rather than leaving the previous pick's
 * frame under the new asset.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing both nodes.
 * @param nodeId - The generative node whose slot is being filled.
 * @param spec - The slot the running pick fills, from whichever registry names it.
 * @param clicked - The node the user clicked.
 * @returns True when the slot was filled, false when the click was refused.
 */
export function fillSlot(
  projectId: string,
  spaceId: string,
  nodeId: string,
  spec: SlotSpec,
  clicked: ClickedNode,
): boolean {
  const value = slotFillValue(spec, clicked);
  if (value === null) return false;
  setNodeSlotValue(projectId, spaceId, nodeId, spec.field, value);
  return true;
}

/**
 * Empties a slot.
 *
 * One key holds the whole pick, so clearing it takes the poster with it — a
 * poster left behind would keep painting a video the slot no longer holds.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The generative node whose slot is being cleared.
 * @param spec - The slot to empty.
 */
export function clearSlot(
  projectId: string,
  spaceId: string,
  nodeId: string,
  spec: SlotSpec,
): void {
  setNodeSlotValue(projectId, spaceId, nodeId, spec.field, null);
}
