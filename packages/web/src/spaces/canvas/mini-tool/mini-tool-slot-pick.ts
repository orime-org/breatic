// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Picking a mini-tool slot from the canvas (inner#888 §7.3). The pick reads
 * the slot off the open tool's registry entry and writes into the panel's
 * draft, never into a node; the click dispatch and the candidate dimming both
 * judge through {@link miniToolSlotCandidate}, so what looks pickable and
 * what a click takes cannot disagree.
 */

import { miniToolById, type MiniToolSlot, type MiniToolSlotValue, type MiniToolSpec } from '@breatic/shared/mini-tools';

import {
  pickedSlotCover,
  pickedSlotDuration,
  pickedSlotUrl,
  type ClickedNode,
} from '@web/spaces/canvas/generate/slot-pick';
import { isJoinSlot, joinToolFor } from '@web/spaces/canvas/mini-tool/join';
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
 * What a slot already holds, which a list slot does not take twice: the
 * addresses, or for a join's list the nodes its clips were picked from
 * (inner#1825 §6.5), so two nodes holding one file are two clips.
 * @param draft - The open draft.
 * @param slot - The slot.
 * @returns The held addresses, or node ids for a join's list.
 */
export function heldSlotUrls(draft: MiniToolDraft, slot: MiniToolSlot): Set<string> {
  const held = draft.slots[slot.key];
  if (held === undefined) return new Set();
  const list = Array.isArray(held) ? (held as readonly MiniToolSlotValue[]) : [held as MiniToolSlotValue];
  const join = isJoinSlot(slot);
  return new Set(list.flatMap((value) => (join ? (value.nodeId === undefined ? [] : [value.nodeId]) : [value.url])));
}

/**
 * Whether a click on this node fills the slot: a node of the kind the slot
 * takes, holding something, other than the panel's own node, and not already
 * in the slot. A join's list holds its host like any clip, so the host is a
 * candidate once the user took it out (inner#1825 §6.5).
 * @param node - The node.
 * @param node.id - Its id.
 * @param target - The node the panel is open on.
 * @param slot - The slot.
 * @param held - What the slot already holds, as {@link heldSlotUrls} reads it.
 * @returns True for a candidate.
 */
export function miniToolSlotCandidate(
  node: ClickedNode & { id: string },
  target: string,
  slot: MiniToolSlot,
  held: ReadonlySet<string>,
): boolean {
  const url = pickedSlotUrl(node, slot.accepts);
  if (url === null) return false;
  if (isJoinSlot(slot)) return !held.has(node.id);
  return node.id !== target && !held.has(url);
}

/**
 * What a pick copies off the clicked node: its address, its poster, its
 * length, and the node's id and name, which the draft orders and wires by.
 * @param node - The clicked node.
 * @returns The slot value, or null when the node holds nothing.
 */
export function miniToolSlotValue(node: ClickedNode & { id?: string; data?: { name?: unknown } }): MiniToolSlotValue | null {
  const content = node.data?.content;
  if (typeof content !== 'string' || content.length === 0) return null;
  const cover = pickedSlotCover(node);
  const duration = pickedSlotDuration(node);
  const name = node.data?.name;
  return {
    url: content,
    ...(cover !== null && { cover }),
    ...(duration !== null && { duration }),
    ...(node.id !== undefined && { nodeId: node.id }),
    ...(typeof name === 'string' && { name }),
  };
}

/** A canvas node as the selection reads it. */
interface SelectedNode {
  id: string;
  type?: string | undefined;
  position: { x: number; y: number };
  parentId?: string | undefined;
  selected?: boolean | undefined;
  data?: Record<string, unknown>;
}

/**
 * The join a multi-selection offers (inner#1825 §6.5): with group nodes left
 * out, two or more selected nodes all video or all audio, each holding
 * something; its clips in canvas order, left to right and top to bottom by
 * where each sits, a grouped node at its group's origin plus its own position.
 * @param nodes - Every node on the canvas, the selected ones flagged.
 * @returns The tool and its clips, or null when the selection offers none.
 */
export function joinOfSelection(nodes: readonly SelectedNode[]): { tool: MiniToolSpec; clips: MiniToolSlotValue[] } | null {
  const picked = nodes.filter((node) => node.selected === true && node.type !== 'group');
  const type = picked[0]?.type;
  const tool = type === undefined ? undefined : joinToolFor(type);
  if (tool === undefined || picked.length < 2 || picked.some((node) => node.type !== type)) return null;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const placed = picked.map((node) => {
    const origin = node.parentId === undefined ? undefined : byId.get(node.parentId)?.position;
    return { node, x: node.position.x + (origin?.x ?? 0), y: node.position.y + (origin?.y ?? 0), value: miniToolSlotValue(node) };
  });
  if (placed.some((one) => one.value === null)) return null;
  placed.sort((a, b) => a.x - b.x || a.y - b.y);
  return { tool, clips: placed.map((one) => one.value as MiniToolSlotValue) };
}
