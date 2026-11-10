// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The join tools (inner#1825 §6.5): their draft holds the whole ordered list
 * of clips, the first one included, keyed by the node each clip was picked
 * from, so the panel's host is one clip like the others.
 */

import { MINI_TOOLS, type ContainerOp, type MiniToolSlot, type MiniToolSlotValue, type MiniToolSpec } from '@breatic/shared/mini-tools';

import type { MiniToolDraft } from '@web/stores/canvas-session';

/** The container operations that join clips end to end. */
const JOIN_OPS: ReadonlySet<ContainerOp> = new Set<ContainerOp>(['join', 'audio_join']);

/**
 * Whether a tool joins clips.
 * @param spec - The tool.
 * @returns True for the video and the audio join.
 */
export function isJoinTool(spec: MiniToolSpec): boolean {
  return spec.run.kind === 'container' && JOIN_OPS.has(spec.run.op);
}

/** The join tools' clip lists, as the registry declares them. */
const JOIN_SLOTS: ReadonlySet<MiniToolSlot> = new Set(MINI_TOOLS.filter(isJoinTool).flatMap((spec) => spec.slots));

/**
 * Whether a slot is a join's clip list, which is keyed by node, not by address.
 * @param slot - The slot, as the registry declares it.
 * @returns True for a join's list.
 */
export function isJoinSlot(slot: MiniToolSlot): boolean {
  return JOIN_SLOTS.has(slot);
}

/**
 * The join tool for a medium.
 * @param type - The clips' node type.
 * @returns The tool, or undefined for a medium nothing joins.
 */
export function joinToolFor(type: string): MiniToolSpec | undefined {
  return MINI_TOOLS.find((spec) => spec.source === type && isJoinTool(spec));
}

/**
 * The node a join draft's first clip was picked from, which its run reads as the source.
 * @param draft - The open draft.
 * @returns The node id, or undefined when the draft holds no list.
 */
export function joinFirstClipOf(draft: MiniToolDraft | null): string | undefined {
  const list = Object.values(draft?.slots ?? {}).find((held) => Array.isArray(held)) as readonly MiniToolSlotValue[] | undefined;
  return list?.[0]?.nodeId;
}
