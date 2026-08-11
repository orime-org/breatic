// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Filling and clearing a video slot — the only place that knows which node
 * fields one slot owns.
 *
 * Most slots own a single field, but a slot taking something an `<img>` cannot
 * paint owns two: the asset and the poster shown for it (#1918). Both writes
 * go in one transaction, so a collaborator never sees a new pick wearing the
 * previous one's poster — a frame out of a different video.
 *
 * Kept apart from the registry itself: that table is data every layer reads,
 * including the toolbar and the payload builder, while this reaches the
 * document. Kept apart from `slot-pick` too — that answers "can this node fill
 * the slot", which the image panel's style slot asks as well, and this writes
 * fields only the video registry names.
 */

import { setNodeSlotFields } from '@web/data/yjs/canvas-space';
import {
  pickedSlotCover,
  pickedSlotUrl,
} from '@web/spaces/canvas/generate/slot-pick';
import type { ClickedNode } from '@web/spaces/canvas/generate/slot-pick';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';
import type {
  VideoSlot,
  VideoSlotSpec,
} from '@web/spaces/canvas/generate/video-slots';

/**
 * Copies a clicked node into a slot, every field that slot owns at once.
 *
 * Refuses the click when the node cannot fill the slot — the candidate
 * dimming already says so, and this backstops an insisting click. A node with
 * no poster clears the poster key rather than leaving the previous pick's
 * frame under the new asset.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing both nodes.
 * @param nodeId - The generative node whose slot is being filled.
 * @param slot - Which slot the running pick fills.
 * @param clicked - The node the user clicked.
 * @returns True when the slot was filled, false when the click was refused.
 */
export function fillSlot(
  projectId: string,
  spaceId: string,
  nodeId: string,
  slot: VideoSlot,
  clicked: ClickedNode,
): boolean {
  const spec: VideoSlotSpec = VIDEO_SLOTS[slot];
  const url = pickedSlotUrl(clicked, spec.accepts);
  if (url === null) return false;
  setNodeSlotFields(projectId, spaceId, nodeId, {
    [spec.field]: url,
    ...(spec.coverField ? { [spec.coverField]: pickedSlotCover(clicked) } : {}),
  });
  return true;
}

/**
 * Empties a slot — every field it owns, in one transaction.
 *
 * A poster left behind would keep painting a video the slot no longer holds.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The generative node whose slot is being cleared.
 * @param slot - Which slot to empty.
 */
export function clearSlot(
  projectId: string,
  spaceId: string,
  nodeId: string,
  slot: VideoSlot,
): void {
  const spec: VideoSlotSpec = VIDEO_SLOTS[slot];
  setNodeSlotFields(projectId, spaceId, nodeId, {
    [spec.field]: null,
    ...(spec.coverField ? { [spec.coverField]: null } : {}),
  });
}
