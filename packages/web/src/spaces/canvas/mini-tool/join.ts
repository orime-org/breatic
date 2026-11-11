// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The join tools (inner#1825 §6.5): their draft holds the whole ordered list
 * of clips, the first one included, keyed by the node each clip was picked
 * from, so the panel's host is one clip like the others.
 */

import {
  MINI_TOOLS,
  type ContainerOp,
  type MiniToolSlot,
  type MiniToolSlotValue,
  type MiniToolSpec,
  type NumberParam,
} from '@breatic/shared/mini-tools';

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
  return joinClipsOf(draft?.slots ?? {})[0]?.nodeId;
}

/**
 * A join draft's ordered clip list.
 * @param slots - The draft's slots.
 * @returns The list, empty when the draft holds none.
 */
export function joinClipsOf(slots: Readonly<Record<string, unknown>>): readonly MiniToolSlotValue[] {
  const list = Object.values(slots).find((held) => Array.isArray(held)) as readonly MiniToolSlotValue[] | undefined;
  return list ?? [];
}

/**
 * The longest crossfade a join's list takes: the tool's own maximum, held to
 * half the shortest clip on the param's step, the most the container blends
 * any neighbour pair over (inner#1825 §6.5).
 * @param spec - The tool.
 * @param param - The number param.
 * @param slots - The draft's slots.
 * @returns The cap, or undefined when the param is not a join's crossfade.
 */
export function joinCrossfadeCap(
  spec: MiniToolSpec,
  param: NumberParam,
  slots: Readonly<Record<string, unknown>>,
): number | undefined {
  if (!isJoinTool(spec)) return undefined;
  const lengths = joinClipsOf(slots).flatMap((clip) => (clip.duration === undefined ? [] : [clip.duration]));
  if (lengths.length === 0) return param.max;
  // The tolerance keeps an exact half (4 s → 2 s) from flooring a step short.
  const steps = Math.floor(Math.min(...lengths) / 2 / param.step + 1e-9);
  return Math.min(param.max, Number((steps * param.step).toFixed(6)));
}

/**
 * The shortest clip in a join's list, of those whose length is known.
 * @param slots - The draft's slots.
 * @returns Its length in seconds, or undefined when no clip has one.
 */
export function joinShortestClip(slots: Readonly<Record<string, unknown>>): number | undefined {
  const lengths = joinClipsOf(slots).flatMap((clip) => (clip.duration === undefined ? [] : [clip.duration]));
  return lengths.length === 0 ? undefined : Math.min(...lengths);
}

/**
 * How long a join comes out: every clip end to end, less one crossfade per
 * meeting of two neighbours.
 * @param slots - The draft's slots.
 * @param crossfade - The crossfade in seconds.
 * @returns The length in seconds, or undefined while any clip's length is unknown.
 */
export function joinTotalSeconds(slots: Readonly<Record<string, unknown>>, crossfade: number): number | undefined {
  const clips = joinClipsOf(slots);
  if (clips.length === 0 || clips.some((clip) => clip.duration === undefined)) return undefined;
  return clips.reduce((sum, clip) => sum + (clip.duration ?? 0), 0) - crossfade * (clips.length - 1);
}
