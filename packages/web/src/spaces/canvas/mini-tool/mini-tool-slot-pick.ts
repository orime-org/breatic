// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Picking a mini-tool slot from the canvas (inner#888 §7.3). The pick reads
 * the slot off the open tool's registry entry and writes into the panel's
 * draft, never into a node; the click dispatch and the candidate dimming both
 * judge through {@link miniToolSlotCandidate}, so what looks pickable and
 * what a click takes cannot disagree.
 */

import { miniToolById, type MiniToolSlot, type MiniToolSlotValue } from '@breatic/shared';

import {
  pickedSlotCover,
  pickedSlotDuration,
  pickedSlotUrl,
  type ClickedNode,
} from '@web/spaces/canvas/generate/slot-pick';
import type { MiniToolDraft, PickSession } from '@web/stores/canvas-session';

/**
 * The slot a running pick fills.
 * @param session - The pick.
 * @param draft - The open mini-tool draft, or null when none is open.
 * @returns The slot, or undefined when this is not a mini-tool slot pick.
 */
export function activeMiniToolSlot(
  session: PickSession,
  draft: MiniToolDraft | null,
): MiniToolSlot | undefined {
  if (session.purpose !== 'miniToolSlot' || draft === null) return undefined;
  return miniToolById(draft.toolId)?.slots.find((slot) => slot.key === session.slotKey);
}

/**
 * The addresses a slot already holds, which a list slot does not take twice.
 * @param draft - The open draft.
 * @param slot - The slot.
 * @returns The held addresses.
 */
export function heldSlotUrls(draft: MiniToolDraft, slot: MiniToolSlot): Set<string> {
  const held = draft.slots[slot.key];
  if (held === undefined) return new Set();
  const list = Array.isArray(held) ? (held as readonly MiniToolSlotValue[]) : [held as MiniToolSlotValue];
  return new Set(list.map((value) => value.url));
}

/**
 * Whether a click on this node fills the slot: a node of the kind the slot
 * takes, holding something, other than the panel's own node, and not already
 * in the slot.
 * @param node - The node.
 * @param node.id - Its id.
 * @param target - The node the panel is open on.
 * @param slot - The slot.
 * @param held - What the slot already holds.
 * @returns True for a candidate.
 */
export function miniToolSlotCandidate(
  node: ClickedNode & { id: string },
  target: string,
  slot: MiniToolSlot,
  held: ReadonlySet<string>,
): boolean {
  if (node.id === target) return false;
  const url = pickedSlotUrl(node, slot.accepts);
  return url !== null && !held.has(url);
}

/**
 * What a pick copies off the clicked node: its address, its poster, its length.
 * @param node - The clicked node.
 * @returns The slot value, or null when the node holds nothing.
 */
export function miniToolSlotValue(node: ClickedNode): MiniToolSlotValue | null {
  const content = node.data?.content;
  if (typeof content !== 'string' || content.length === 0) return null;
  const cover = pickedSlotCover(node);
  const duration = pickedSlotDuration(node);
  return {
    url: content,
    ...(cover !== null && { cover }),
    ...(duration !== null && { duration }),
  };
}
